"""API 文档：基于路由自省自动生成在线文档页。

访问 /api/docs 查看交互式 API 文档（仿 Swagger UI 风格）。
"""
from flask import Blueprint, jsonify

docs_bp = Blueprint("docs", __name__)

# 手动定义 API 路由文档（自动注册时填充）
API_DEFS = [
    # ── 流媒体 ──
    {"method": "GET",    "path": "/stream/<bitrate>",          "tag": "流媒体", "desc": "多码率音频流（如 /stream/64, /stream/320）", "auth": False},
    {"method": "GET",    "path": "/stream",                    "tag": "流媒体", "desc": "默认音频流（支持 ICY 元数据）", "auth": False},
    {"method": "GET",    "path": "/hls/<name>",                "tag": "流媒体", "desc": "HLS 直播切片（.m3u8 / .ts）", "auth": False},
    {"method": "GET",    "path": "/rss",                       "tag": "流媒体", "desc": "播客 RSS（录制存档）", "auth": False},
    # ── 状态 ──
    {"method": "GET",    "path": "/api/status",                "tag": "状态",   "desc": "当前播放状态 + 歌单信息", "auth": False},
    {"method": "GET",    "path": "/api/health",                "tag": "状态",   "desc": "服务健康检查（磁盘/运行时间/监听数）", "auth": False},
    {"method": "GET",    "path": "/api/listeners",             "tag": "状态",   "desc": "听众连接日志", "auth": False},
    {"method": "GET",    "path": "/api/stats/listeners",       "tag": "状态",   "desc": "24h 听众统计曲线", "auth": False},
    {"method": "GET",    "path": "/api/meta",                  "tag": "状态",   "desc": "当前曲目标签元数据", "auth": False},
    {"method": "GET",    "path": "/api/cover",                 "tag": "状态",   "desc": "当前曲目封面图", "auth": False},
    {"method": "GET",    "path": "/api/lyrics",                "tag": "状态",   "desc": "当前曲目歌词（LRC）", "auth": False},
    {"method": "GET",    "path": "/api/hls/status",            "tag": "状态",   "desc": "HLS 切片器状态", "auth": False},
    {"method": "GET",    "path": "/api/public-url",            "tag": "状态",   "desc": "公网穿透地址", "auth": False},
    # ── 控制（需登录） ──
    {"method": "POST",   "path": "/api/play",                  "tag": "控制",   "desc": "播放 / 继续", "auth": True},
    {"method": "POST",   "path": "/api/stop",                  "tag": "控制",   "desc": "暂停播放", "auth": True},
    {"method": "POST",   "path": "/api/pause",                 "tag": "控制",   "desc": "切换暂停/播放", "auth": True},
    {"method": "POST",   "path": "/api/skip",                  "tag": "控制",   "desc": "下一首", "auth": True},
    {"method": "POST",   "path": "/api/shuffle",               "tag": "控制",   "desc": "随机模式开关", "auth": True},
    {"method": "POST",   "path": "/api/repeat",                "tag": "控制",   "desc": "单曲循环开关", "auth": True},
    {"method": "POST",   "path": "/api/volume",                "tag": "控制",   "desc": "设置音量 (0-100)", "auth": True},
    {"method": "POST",   "path": "/api/rescan",                "tag": "控制",   "desc": "重新扫描歌单", "auth": True},
    {"method": "POST",   "path": "/api/relay",                 "tag": "控制",   "desc": "开始在线转播", "auth": True},
    {"method": "POST",   "path": "/api/relay/stop",            "tag": "控制",   "desc": "停止转播", "auth": True},
    {"method": "POST",   "path": "/api/record",                "tag": "控制",   "desc": "录音开关", "auth": True},
    {"method": "POST",   "path": "/api/request",               "tag": "控制",   "desc": "点歌（模糊匹配）", "auth": False},
    {"method": "POST",   "path": "/api/request/clear",         "tag": "控制",   "desc": "清空点歌队列", "auth": True},
    {"method": "POST",   "path": "/api/announce",              "tag": "控制",   "desc": "立即分享到 Discord/Telegram", "auth": True},
    # ── 全球电台 ──
    {"method": "GET",    "path": "/api/browse",                "tag": "电台",   "desc": "搜索全球电台（Radio-Browser.info）", "auth": False},
    {"method": "GET",    "path": "/api/favorites",             "tag": "电台",   "desc": "已收藏电台列表", "auth": False},
    {"method": "POST",   "path": "/api/favorites",             "tag": "电台",   "desc": "收藏电台", "auth": True},
    # ── 电台预设 ──
    {"method": "GET",    "path": "/api/presets",               "tag": "预设",   "desc": "电台预设列表", "auth": False},
    {"method": "POST",   "path": "/api/presets/switch",        "tag": "预设",   "desc": "切换电台预设", "auth": True},
    {"method": "POST",   "path": "/api/presets/add",           "tag": "预设",   "desc": "添加电台预设", "auth": True},
    {"method": "PUT",    "path": "/api/presets/<preset_id>",   "tag": "预设",   "desc": "更新电台预设", "auth": True},
    {"method": "DELETE", "path": "/api/presets/<preset_id>",   "tag": "预设",   "desc": "删除电台预设", "auth": True},
    # ── 认证 ──
    {"method": "POST",   "path": "/login",                     "tag": "认证",   "desc": "用户登录（Cookie Session）", "auth": False},
    {"method": "GET",    "path": "/logout",                    "tag": "认证",   "desc": "用户登出", "auth": False},
    {"method": "GET",    "path": "/api/auth/status",           "tag": "认证",   "desc": "查询认证状态", "auth": False},
    {"method": "POST",   "path": "/api/auth/password",         "tag": "认证",   "desc": "修改管理员密码", "auth": True},
    # ── 文件管理 ──
    {"method": "POST",   "path": "/api/upload",                "tag": "文件",   "desc": "上传音乐文件（批量）", "auth": True},
    {"method": "GET",    "path": "/api/upload/progress/<task_id>","tag": "文件", "desc": "查询上传进度", "auth": True},
    {"method": "GET",    "path": "/api/files",                 "tag": "文件",   "desc": "列出所有音乐文件", "auth": True},
    {"method": "DELETE", "path": "/api/files/<filename>",      "tag": "文件",   "desc": "删除音乐文件", "auth": True},
    {"method": "GET",    "path": "/files",                     "tag": "文件",   "desc": "文件管理 Web 页面", "auth": True},
    # ── 节目单 ──
    {"method": "GET",    "path": "/api/schedule",              "tag": "节目单", "desc": "查看排程", "auth": False},
    {"method": "POST",   "path": "/api/schedule",              "tag": "节目单", "desc": "保存排程", "auth": True},
    {"method": "POST",   "path": "/api/schedule/enable",       "tag": "节目单", "desc": "启用/禁用节目单", "auth": True},
    # ── 集成 ──
    {"method": "GET",    "path": "/api/integrations",          "tag": "集成",   "desc": "社群集成状态（Discord/Telegram）", "auth": False},
    {"method": "POST",   "path": "/api/integrations",          "tag": "集成",   "desc": "保存社群集成配置", "auth": True},
]


@docs_bp.route("/api/docs")
def api_docs():
    """渲染 API 文档页面。"""
    return _render_swagger_page()


@docs_bp.route("/api/openapi.json")
def openapi_spec():
    """返回 OpenAPI 3.0 规范 JSON。"""
    return jsonify(_build_spec())


def _build_spec():
    """构建 OpenAPI 3.0 规范。"""
    paths = {}
    tags = set()
    for d in API_DEFS:
        tags.add(d["tag"])
        # 标准化路径
        raw = d["path"]
        # Flask 参数 <xxx> → OpenAPI {xxx}
        clean_path = raw.replace("<", "{").replace(">", "}")
        if clean_path not in paths:
            paths[clean_path] = {}
        op = {
            "operationId": f"{d['method'].lower()}_{clean_path.strip('/').replace('/', '_').replace('{', '').replace('}', '')}"[:80],
            "summary": d["desc"],
            "tags": [d["tag"]],
            "security": [{"cookieAuth": []}] if d["auth"] else [],
            "responses": {"200": {"description": "成功"}},
        }
        paths[clean_path][d["method"].lower()] = op

    return {
        "openapi": "3.0.3",
        "info": {
            "title": "Radio Station API",
            "version": "2.0",
            "description": "自托管网络电台 API — 支持流媒体控制、文件管理、全球电台搜索等功能。\n\n认证方式：Cookie-based Session（先 POST /login 获取 cookie）。"
        },
        "tags": [{"name": t, "description": ""} for t in sorted(tags)],
        "paths": paths,
    }


def _render_swagger_page():
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API 文档 - 电台</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style>
body{margin:0;background:#0d1117}
.swagger-ui{filter:invert(88%) hue-rotate(180deg) brightness(.9)}
.swagger-ui .topbar{display:none}
.swagger-ui .opblock-tag{font-size:18px!important}
.back-link{display:block;padding:16px 24px;color:#58a6ff;text-decoration:none;font-size:14px;position:absolute;z-index:100}
.back-link:hover{text-decoration:underline}
</style>
</head>
<body>
<a href="/" class="back-link">← 返回电台主页</a>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
SwaggerUIBundle({url:"/api/openapi.json",dom_id:"#swagger-ui",deepLinking:true,defaultModelsExpandDepth:-1})
</script>
</body>
</html>"""
