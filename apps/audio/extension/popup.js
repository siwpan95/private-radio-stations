"use strict";

const $ = (id) => document.getElementById(id);

// 服务器地址：优先取选项页配置，缺省 localhost:8000
async function getBase() {
  try {
    const v = await chrome.storage.local.get("serverUrl");
    if (v && v.serverUrl) return v.serverUrl.replace(/\/+$/, "");
  } catch (e) {}
  return "http://localhost:8000";
}

let _status = null;

async function api(path, opts) {
  const base = await getBase();
  return fetch(base + path, opts);
}

// ---------- 状态 ----------
// 3.0 API：/api/status 返回 { version, mode, current:{url,name}, sourceCount, failureCount, hls_url, hls_variants, mounts, ffmpeg }
async function refresh() {
  let s;
  try {
    const r = await api("/api/status");
    if (!r.ok) throw new Error("HTTP " + r.status);
    s = await r.json();
  } catch (e) {
    setError("无法连接电台，请检查服务器是否启动 / 选项页地址");
    return;
  }
  clearError();
  _status = s;

  const cur = s.current || null;
  $("mode").textContent = s.mode === "relay" ? "转播中" : "空闲";
  $("title").textContent = cur ? (cur.name || cur.url) : "—";
  $("sub").textContent = cur ? "来源：" + cur.url : "未转播，可输入流地址开始";
  const info = [];
  if (s.sourceCount) info.push("源 " + s.sourceCount + (s.failureCount ? " · 失败 " + s.failureCount : ""));
  if (s.ffmpeg === false) info.push("无 ffmpeg");
  $("info").textContent = info.join(" · ") || "—";
}

async function startRelay() {
  const raw = ($("relayUrl").value || "").trim();
  if (!raw) return;
  // 3.0 多源 failover：逗号或换行分隔，第一个为主源，其余为备用源
  const urls = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const url = urls[0];
  const fallbacks = urls.slice(1);
  try {
    const r = await api("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fallbacks.length ? { url, fallbacks } : { url }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError("转播失败：" + (j.error || r.status));
      return;
    }
  } catch (e) {
    setError("转播请求失败：" + e);
    return;
  }
  refresh();
}

async function stopRelay() {
  try {
    await api("/api/relay/stop", { method: "POST" });
  } catch (e) {}
  refresh();
}

async function favCurrent() {
  const cur = _status && _status.current;
  if (!cur || _status.mode !== "relay") return;
  try {
    const r = await api("/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: cur.url, name: cur.name || cur.url }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    $("status").textContent = "已收藏到预设 ✓";
  } catch (e) {
    setError("收藏失败：" + e);
  }
}

// ---------- 错误提示 ----------
function setError(msg) {
  $("status").textContent = msg;
  $("status").style.color = "#ff8ab0";
}
function clearError() {
  $("status").textContent =
    "本地电台 · " + (location.origin || "localhost:8000") +
    (_status && _status.version ? " · v" + _status.version : "");
  $("status").style.color = "";
}

// ---------- 绑定 ----------
$("startRelay").addEventListener("click", startRelay);
$("stopRelay").addEventListener("click", stopRelay);
$("fav").addEventListener("click", favCurrent);
$("openOptions").addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 2000);
