// @relay/core — 声明式 loader（视频/音频应用共用）。
// 特性（借鉴 deepseek-harness 装配纪律）：
//   - `!!js` 配置表达式（yml 可写 port: !!js "process.env.PORT || 8100"）；
//   - 行式配置：plugins 为 {id, module?, config?, disabled?, hot?} 数组（兼容旧 map 形式）；
//   - 启动结算审计：逐个 await 插件 fiber，失败点名（带 id + stack）；
//   - 应用后核对每个插件的同名 Service 是否注册（inject 缺失当场暴露）。
import { readFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

// !!js 简写在 YAML 规范里映射到 tag:yaml.org,2002:js，注册必须用完整 URI
const JS_EXPR = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: String(data) }),
})
const JS_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPR])

function evaluateJs(expr, scope) {
  // 作用域受控：仅暴露 process/env/path/__dirname/root
  const fn = new Function('process', 'env', 'path', '__dirname', 'root', 'return (' + expr + ')')
  return fn(scope.process, scope.env, scope.path, scope.__dirname, scope.root)
}

export function interpolate(value, scope) {
  if (value && typeof value === 'object' && value.__jsExpr !== undefined) {
    return evaluateJs(value.__jsExpr, scope)
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, scope)
    return out
  }
  return value
}

// 供质量门禁等复用：按项目 schema（含 !!js）解析 cordis.yml 文本
export function parseCordisYml(text) {
  return yaml.load(text, { schema: JS_SCHEMA }) || {}
}

// P6 行式归一化：新旧两种 cordis.yml 写法 → 统一 Entry 行
export function normalizeEntries(doc) {
  const raw = (doc && doc.plugins) || {}
  if (Array.isArray(raw)) {
    return {
      entries: raw.map((e, i) => {
        if (!e || typeof e !== 'object') throw new Error('[boot] plugins[' + i + '] 必须为对象行');
        if (!e.id) throw new Error('[boot] plugins[' + i + '] 缺少 id');
        return {
          id: String(e.id),
          module: e.module ? String(e.module) : null,
          config: e.config || {},
          disabled: !!e.disabled,
          hot: !!e.hot,
          source: 'base',
        };
      }),
      legacy: false,
    };
  }
  // 旧 map 形式：{ name: cfg }
  return {
    entries: Object.entries(raw).map(([id, config]) => ({
      id,
      module: null,
      config: config || {},
      disabled: false,
      hot: false,
      source: 'base',
    })),
    legacy: true,
  };
}

function defaultPatchPath(yamlPath) {
  return path.join(path.dirname(yamlPath), 'cordis.patch.yml');
}

// P7：读取 patch 文件（默认 cordis.patch.yml + CORDIS_PATCH 环境变量追加）
export function loadPatchFiles(yamlPath) {
  const files = [];
  const def = defaultPatchPath(yamlPath);
  if (fs.existsSync(def)) files.push(def);
  for (const extra of (process.env.CORDIS_PATCH || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    files.push(path.isAbsolute(extra) ? extra : path.resolve(path.dirname(yamlPath), extra));
  }
  const patches = [];
  for (const f of files) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const doc = parseCordisYml(text);
      if (Array.isArray(doc)) patches.push(...doc.map((e) => e || {}));
      else if (doc && Array.isArray(doc.patches)) patches.push(...doc.patches.map((e) => e || {}));
    } catch (e) {
      throw new Error('[boot] patch 文件解析失败 ' + f + ': ' + e.message);
    }
  }
  return patches;
}

// P7：patch 叠加（按 id 覆盖 / before 锚点插入 / disabled 开关）
export function composeEntries(entries, patches) {
  const list = entries.map((e) => ({ ...e, config: { ...e.config } }));
  for (const op of patches) {
    if (!op || typeof op !== 'object' || !op.id) continue;
    if (op.before) {
      // 插入新行（锚点 id 之前；找不到锚点则追加）
      const neu = { id: String(op.id), module: op.module ? String(op.module) : null, config: op.config || {}, disabled: !!op.disabled, hot: !!op.hot, source: 'patch' };
      const idx = list.findIndex((e) => e.id === op.before);
      if (idx >= 0) list.splice(idx, 0, neu);
      else list.push(neu);
      continue;
    }
    const target = list.find((e) => e.id === op.id);
    if (!target) {
      list.push({ id: String(op.id), module: op.module ? String(op.module) : null, config: op.config || {}, disabled: !!op.disabled, hot: !!op.hot, source: 'patch' });
      continue;
    }
    target.source = 'patch';
    if (op.module !== undefined) target.module = op.module ? String(op.module) : null;
    if (op.config !== undefined) target.config = Object.assign({}, target.config, op.config); // 浅层合并
    if (op.disabled !== undefined) target.disabled = !!op.disabled;
    if (op.hot !== undefined) target.hot = !!op.hot;
  }
  return list;
}

export async function start(ctx, opts = {}) {
  const yamlPath = opts.yamlPath || path.join(process.cwd(), 'cordis.yml');
  const pluginsDir = opts.pluginsDir || path.join(process.cwd(), 'src', 'plugins');
  const root = opts.root || path.dirname(yamlPath);
  const scope = { process, env: process.env, path, __dirname: path.dirname(yamlPath), root };

  const raw = await readFile(yamlPath, 'utf8');
  const doc = parseCordisYml(raw);
  const norm = normalizeEntries(doc);
  if (norm.legacy) {
    ctx.logger.warn('[boot] cordis.yml 使用旧 map 形式，建议迁移为行式（见 docs/ROADMAP_CONFIG.md P6）');
  }
  const entries = composeEntries(norm.entries, loadPatchFiles(yamlPath));

  const state = { entries: [], fibers: new Map() };
  ctx.$loader = state;

  // 逐个应用并审计（对应 harness 的 assertEntriesLoaded/assertEntriesActivated）
  for (const entry of entries) {
    if (entry.disabled) {
      ctx.logger.info('[boot] 插件 ' + entry.id + ' 已禁用，跳过');
      continue;
    }
    const cfg = interpolate(entry.config, scope);
    const fiber = await applyEntry(ctx, entry, cfg, pluginsDir);
    state.fibers.set(entry.id, fiber);
    state.entries.push({ ...entry, config: cfg });
  }

  // 核对同名 Service 是否注册（缺 inject 的依赖会在这里点名）
  const appliedIds = state.entries.map((e) => e.id);
  const missing = appliedIds.filter((id) => !ctx[id]);
  if (missing.length) {
    throw new Error('[boot] 以下插件应用后未注册同名服务（检查 Service.inject 依赖链）: ' + missing.join(', '));
  }

  ctx.emit('ready');

  // P8A：patch 热重载（可选，默认关）
  if (opts.watch) startWatcher(ctx, { yamlPath, pluginsDir, root, scope, state });
  return ctx;
}

export async function applyEntry(ctx, entry, cfg, pluginsDir) {
  const modPath = entry.module ? path.resolve(pluginsDir, entry.module) : path.join(pluginsDir, entry.id + '.js');
  let mod;
  try {
    mod = await import(pathToFileURL(modPath).href);
  } catch (e) {
    throw new Error('[boot] 插件 ' + entry.id + ' 加载失败: ' + (e && e.stack ? e.stack : e), { cause: e });
  }
  const plugin = mod.default;
  if (typeof plugin !== 'function') {
    throw new Error('[boot] 插件 "' + entry.id + '" 没有默认导出函数');
  }
  try {
    const fiber = ctx.plugin(plugin, cfg);
    if (fiber && typeof fiber.then === 'function') await fiber;
    return fiber;
  } catch (e) {
    throw new Error('[boot] 插件 ' + entry.id + ' 应用失败: ' + (e && e.stack ? e.stack : e), { cause: e });
  }
}

// ---- P8A watcher（安全子集）----
function startWatcher(ctx, { yamlPath, pluginsDir, scope, state }) {
  const dir = path.dirname(yamlPath);
  let timer = null;
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    timer = setTimeout(() => {
      pending = false;
      reload().catch((e) => ctx.logger.error('[hmr] 重载失败，保持现有配置: ' + e.message));
    }, 300);
  };

  async function reload() {
    const doc = parseCordisYml(fs.readFileSync(yamlPath, 'utf8'));
    const norm = normalizeEntries(doc);
    const next = composeEntries(norm.entries, loadPatchFiles(yamlPath));
    await applyDiff(ctx, { next, state, pluginsDir, scope });
  }

  try {
    fs.watch(dir, (event, filename) => {
      if (filename && /cordis\.patch\.yml$/.test(String(filename))) schedule();
    });
    ctx.logger.info('[hmr] patch 热重载已启用（监听 ' + dir + '）');
  } catch (e) {
    ctx.logger.warn('[hmr] watcher 启动失败: ' + e.message);
  }
}

// P8A diff：按 id 分组比较
export function diffEntries(prev, next) {
  const prevMap = new Map(prev.map((e) => [e.id, e]));
  const nextMap = new Map(next.map((e) => [e.id, e]));
  const added = next.filter((e) => !prevMap.has(e.id));
  const removed = prev.filter((e) => !nextMap.has(e.id));
  const changed = [];
  for (const e of next) {
    const p = prevMap.get(e.id);
    if (!p) continue;
    if (JSON.stringify(p.config) !== JSON.stringify(e.config) || p.disabled !== e.disabled || (p.module || null) !== (e.module || null)) {
      changed.push({ prev: p, next: e });
    }
  }
  return { added, removed, changed };
}

// P8A 应用 diff（安全子集：hot 行可增删改；config 变更走 config:update 白名单事件）
export async function applyDiff(ctx, { next, state, pluginsDir, scope }) {
  const prev = state.entries;
  const diff = diffEntries(prev, next);

  for (const e of diff.removed) {
    if (!e.hot) {
      ctx.logger.warn('[hmr] 拒绝删除非 hot 插件 ' + e.id + '（持有独占资源，需重启）');
      continue;
    }
    const fiber = state.fibers.get(e.id);
    if (fiber) {
      try { await fiber.dispose(); } catch (err) { ctx.logger.error('[hmr] 卸载 ' + e.id + ' 失败: ' + err.message); }
      state.fibers.delete(e.id);
    }
    ctx.logger.info('[hmr] 已卸载 ' + e.id);
  }

  for (const { prev: p, next: n } of diff.changed) {
    if (p.disabled !== n.disabled || (p.module || null) !== (n.module || null)) {
      if (!(p.hot || n.hot)) {
        ctx.logger.warn('[hmr] 拒绝重载非 hot 插件 ' + n.id + '（结构变更需重启）');
        continue;
      }
      const fiber = state.fibers.get(n.id);
      if (fiber) { try { await fiber.dispose(); } catch { /* ignore */ } state.fibers.delete(n.id); }
      if (n.disabled) { ctx.logger.info('[hmr] 已禁用 ' + n.id); continue; }
      try {
        const cfg = interpolate(n.config, scope);
        const f = await applyEntry(ctx, n, cfg, pluginsDir);
        state.fibers.set(n.id, f);
        ctx.logger.info('[hmr] 已重载 ' + n.id);
      } catch (e) {
        // 事务式回滚：重新应用旧配置，恢复「最后已知良好」状态
        ctx.logger.error('[hmr] 重载 ' + n.id + ' 失败，回滚旧配置: ' + e.message);
        try {
          const oldCfg = interpolate(p.config, scope);
          const f = await applyEntry(ctx, p, oldCfg, pluginsDir);
          state.fibers.set(n.id, f);
          ctx.logger.info('[hmr] ' + n.id + ' 已回滚到旧配置');
        } catch (e2) {
          ctx.logger.error('[hmr] ' + n.id + ' 回滚也失败: ' + e2.message);
        }
      }
      continue;
    }
    // 纯 config 变更：走 config:update 事件（各服务白名单生效，下一次动作应用）
    const oldCfg = interpolate(p.config, scope);
    const newCfg = interpolate(n.config, scope);
    ctx.emit('config:update', { id: n.id, config: newCfg, previous: oldCfg });
    ctx.logger.info('[hmr] ' + n.id + ' 配置已热更新（白名单键下一次动作生效）');
  }

  for (const e of diff.added) {
    if (e.disabled) continue;
    if (!e.hot) {
      ctx.logger.warn('[hmr] 拒绝热加载非 hot 插件 ' + e.id + '（需重启）');
      continue;
    }
    try {
      const cfg = interpolate(e.config, scope);
      const f = await applyEntry(ctx, e, cfg, pluginsDir);
      state.fibers.set(e.id, f);
      ctx.logger.info('[hmr] 已热加载 ' + e.id);
    } catch (err) {
      ctx.logger.error('[hmr] 热加载 ' + e.id + ' 失败，已回滚: ' + err.message);
    }
  }

  state.entries = next.map((e) => ({ ...e, config: interpolate(e.config, scope) }));
}
