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
async function refresh() {
  let s;
  try {
    const r = await api("/api/status");
    s = await r.json();
  } catch (e) {
    setError("无法连接电台，请检查服务器是否启动 / 选项页地址");
    return;
  }
  clearError();
  _status = s;

  $("mode").textContent = s.mode === "relay" ? "转播中" : "空闲";
  $("title").textContent = s.current_title || "—";
  $("sub").textContent =
    s.mode === "relay" ? "来源：" + (s.relay_url || "—") : "未转播";
  $("listeners").textContent = "听众 " + (s.listeners || 0);
}

async function startRelay() {
  const url = ($("relayUrl").value || "").trim();
  if (!url) return;
  try {
    await api("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch (e) {}
  refresh();
}

async function stopRelay() {
  try {
    await api("/api/relay/stop", { method: "POST" });
  } catch (e) {}
  refresh();
}

async function favCurrent() {
  if (!_status || _status.mode !== "relay" || !_status.relay_url) return;
  try {
    await api("/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: _status.relay_url, name: _status.current_title || _status.relay_url }),
    });
    $("status").textContent = "已收藏到预设 ✓";
  } catch (e) {}
}

// ---------- 错误提示 ----------
function setError(msg) {
  $("status").textContent = msg;
  $("status").style.color = "#ff8ab0";
}
function clearError() {
  $("status").textContent = "本地电台 · " + (location.origin || "localhost:8000");
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
