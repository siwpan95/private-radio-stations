"""电台预设系统：支持多电台配置切换。

配置示例（编辑 station_presets.json）：
{
  "personal": {
    "name": "我的私人电台",
    "description": "我的音乐收藏",
    "music_dir": "music/",
    "playlist_mode": "shuffle",
    "crossfade": 3.0,
    "volume": 80
  },
  "lofi": {
    "name": "Lo-Fi 电台",
    "description": "24/7 Lo-Fi Hip Hop",
    "music_dir": "music_lofi/",
    "repeat": true,
    "crossfade": 1.0,
    "volume": 60
  }
}
"""
import json
import os
import shutil
from flask import request, jsonify
from . import config
from .auth import api_login_required

PRESETS_PATH = os.path.join(config.BASE_DIR, "station_presets.json")
_DEFAULT_PRESET_ID = "default"

# 默认预设配置
DEFAULT_PRESETS = {
    "default": {
        "name": config.STATION_NAME,
        "description": "默认电台",
        "music_dir": config.MUSIC_DIR,
        "playlist_mode": "shuffle",
        "crossfade": 3.0,
        "volume": 80,
    }
}


def _load_presets() -> dict:
    """加载预设配置。"""
    if not os.path.isfile(PRESETS_PATH):
        return DEFAULT_PRESETS
    try:
        with open(PRESETS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return DEFAULT_PRESETS


def _save_presets(presets: dict):
    """保存预设配置。"""
    tmp = PRESETS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(presets, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PRESETS_PATH)


def get_preset(preset_id: str) -> dict:
    """获取指定预设。"""
    presets = _load_presets()
    return presets.get(preset_id) or presets.get("default", {})


def get_active_preset() -> dict:
    """获取当前激活的预设。"""
    active_file = os.path.join(config.BASE_DIR, ".active_preset")
    active_id = _DEFAULT_PRESET_ID
    if os.path.isfile(active_file):
        try:
            with open(active_file, "r") as f:
                active_id = f.read().strip()
        except Exception:
            pass
    return get_preset(active_id)


def set_active_preset(preset_id: str) -> bool:
    """切换激活预设。"""
    presets = _load_presets()
    if preset_id not in presets:
        return False
    active_file = os.path.join(config.BASE_DIR, ".active_preset")
    with open(active_file, "w") as f:
        f.write(preset_id)
    return True


def register_routes(app):
    """注册电台预设相关路由。"""

    @app.route("/api/presets", methods=["GET"])
    def api_list_presets():
        """列出所有电台预设。"""
        presets = _load_presets()
        active = get_active_preset().get("name", "default")
        result = {}
        for pid, pdata in presets.items():
            result[pid] = {
                "name": pdata.get("name", pid),
                "description": pdata.get("description", ""),
                "active": pdata.get("name") == active,
            }
        return jsonify({"ok": True, "presets": result})

    @app.route("/api/presets/switch", methods=["POST"])
    @api_login_required
    def api_switch_preset():
        """切换电台预设。"""
        body = request.get_json(silent=True) or {}
        preset_id = (body.get("id") or "").strip()
        if not preset_id:
            return jsonify({"ok": False, "error": "缺少预设 ID"}), 400
        if not set_active_preset(preset_id):
            return jsonify({"ok": False, "error": "预设不存在"}), 404
        return jsonify({
            "ok": True,
            "preset": preset_id,
            "note": "预设已切换，需要重启电台才能生效（POST /api/restart）"
        })

    @app.route("/api/presets/add", methods=["POST"])
    @api_login_required
    def api_add_preset():
        """添加新预设。"""
        body = request.get_json(silent=True) or {}
        pid = (body.get("id") or "").strip()
        if not pid:
            return jsonify({"ok": False, "error": "缺少预设 ID"}), 400
        presets = _load_presets()
        if pid in presets:
            return jsonify({"ok": False, "error": "预设 ID 已存在"}), 409
        presets[pid] = {
            "name": body.get("name", pid),
            "description": body.get("description", ""),
            "music_dir": body.get("music_dir", "music/"),
            "crossfade": float(body.get("crossfade", 3.0)),
            "volume": int(body.get("volume", 80)),
        }
        _save_presets(presets)
        return jsonify({"ok": True, "preset": presets[pid]})

    @app.route("/api/presets/<preset_id>", methods=["PUT"])
    @api_login_required
    def api_update_preset(preset_id):
        """更新预设。"""
        presets = _load_presets()
        if preset_id not in presets:
            return jsonify({"ok": False, "error": "预设不存在"}), 404
        body = request.get_json(silent=True) or {}
        if "name" in body:
            presets[preset_id]["name"] = body["name"]
        if "description" in body:
            presets[preset_id]["description"] = body["description"]
        if "music_dir" in body:
            presets[preset_id]["music_dir"] = body["music_dir"]
        if "crossfade" in body:
            presets[preset_id]["crossfade"] = float(body["crossfade"])
        if "volume" in body:
            presets[preset_id]["volume"] = int(body["volume"])
        _save_presets(presets)
        return jsonify({"ok": True, "preset": presets[preset_id]})

    @app.route("/api/presets/<preset_id>", methods=["DELETE"])
    @api_login_required
    def api_delete_preset(preset_id):
        """删除预设（不允许删除 default）。"""
        if preset_id == "default":
            return jsonify({"ok": False, "error": "不允许删除 default 预设"}), 403
        presets = _load_presets()
        if preset_id not in presets:
            return jsonify({"ok": False, "error": "预设不存在"}), 404
        del presets[preset_id]
        _save_presets(presets)
        return jsonify({"ok": True})
