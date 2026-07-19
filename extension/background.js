"use strict";

// 后台：根据播放状态更新工具栏图标徽标；并暴露“保存到服务器”的兜底通道。
async function getBase() {
  try {
    const v = await chrome.storage.local.get("serverUrl");
    if (v && v.serverUrl) return v.serverUrl.replace(/\/+$/, "");
  } catch (e) {}
  return "http://localhost:8000";
}

async function updateBadge() {
  try {
    const base = await getBase();
    const r = await fetch(base + "/api/status");
    const s = await r.json();
    if (s && !s.paused && s.current_title) {
      chrome.action.setBadgeText({ text: "♪" });
      chrome.action.setBadgeBackgroundColor({ color: "#9b5cff" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {
    chrome.action.setBadgeText({ text: "" });
  }
}

// 每 5s 刷新徽标
updateBadge();
setInterval(updateBadge, 5000);

// 选项页“保存”时也会触发；这里在后台兜底连一次服务器确认状态
chrome.runtime.onInstalled.addListener(updateBadge);
