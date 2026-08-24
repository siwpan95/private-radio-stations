// @relay/core — 分层设置服务（借鉴 deepseek-harness packages/settings）。
// 解析值 = schema 默认 → base → 用户文档（data/settings.json）三层合并；
// 写带 expectedRevision 乐观锁（SETTINGS_CONFLICT）；快照深冻结；对外可脱敏。
import { Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'

const SECRET_RE = /key|token|secret|password/i

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

export function redactSecrets(obj) {
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = SECRET_RE.test(k) ? '***' : redactSecrets(v);
    }
    return out;
  }
  return obj;
}

export class SettingsService extends Service {
  constructor(ctx, cfg = {}) {
    super(ctx, 'settings')
    this.namespaces = new Map(); // ns -> { schema, base }
    const root = (ctx.config && ctx.config.root) || process.cwd();
    this.file = (cfg.file && path.isAbsolute(cfg.file)) ? cfg.file : path.resolve(root, cfg.file || path.join('data', 'settings.json'))
    // 外部修改监听：文件变更 → 重读并广播 settings:update（P9 验收项）
    try {
      let timer = null
      fs.watch(path.dirname(this.file), (event, filename) => {
        if (!filename || path.basename(String(filename)) !== path.basename(this.file)) return
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          const rev = this._readDoc().revision
          this.ctx.logger.info('[settings] 检测到外部修改 settings.json（rev ' + rev + '）')
          this.ctx.emit('settings:update', { file: this.file, revision: rev, external: true })
        }, 300)
      })
    } catch { /* 目录尚不存在等，忽略 */ }
  }

  register(ns, schema, opts = {}) {
    this.namespaces.set(ns, { schema, base: opts.base || {} });
  }

  _readDoc() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { revision: 0, values: {} };
    }
  }

  _writeDoc(doc) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, this.file); // 原子替换
  }

  _schemaDefaults(schema) {
    const inst = new schema({});
    return JSON.parse(JSON.stringify(inst));
  }

  // 三层合并：schema 默认 → base → 用户文档
  resolve(ns) {
    const reg = this.namespaces.get(ns);
    if (!reg) return null;
    const doc = this._readDoc();
    const value = deepMerge(deepMerge(this._schemaDefaults(reg.schema), reg.base), doc.values[ns] || {});
    return { ns, value: deepFreeze(value), revision: doc.revision, base: deepFreeze(reg.base) };
  }

  // 乐观并发：expectedRevision 不符抛 SETTINGS_CONFLICT
  set(ns, patch, expectedRevision) {
    if (!this.namespaces.has(ns)) throw new Error('未知命名空间: ' + ns);
    const doc = this._readDoc();
    if (expectedRevision !== undefined && doc.revision !== expectedRevision) {
      const err = new Error('设置已被其他端修改（revision ' + doc.revision + '），请刷新后重试');
      err.code = 'SETTINGS_CONFLICT';
      throw err;
    }
    doc.values[ns] = deepMerge(doc.values[ns] || {}, patch || {});
    doc.revision = (doc.revision || 0) + 1;
    this._writeDoc(doc);
    this.ctx.emit('settings:update', { ns, revision: doc.revision });
    return this.resolve(ns);
  }

  status() {
    return { namespaces: [...this.namespaces.keys()], revision: this._readDoc().revision, file: this.file };
  }
}

SettingsService.inject = ['config']

export default function settingsPlugin(ctx, cfg) {
  ctx.plugin(SettingsService, cfg);
}