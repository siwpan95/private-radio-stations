"use strict";

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "http://localhost:8000";

async function getBase() {
  try {
    const v = await chrome.storage.local.get("serverUrl");
    if (v && v.serverUrl) return v.serverUrl.replace(/\/+$/, "");
  } catch (e) {}
  return DEFAULT_SERVER;
}

// 读取已保存的服务器地址
async function loadAll() {
  try {
    const v = await chrome.storage.local.get("serverUrl");
    $("serverUrl").value = (v && v.serverUrl) || DEFAULT_SERVER;
  } catch (e) {
    $("serverUrl").value = DEFAULT_SERVER;
  }
}

async function save() {
  const msg = $("msg");
  msg.className = "";
  msg.textContent = "";
  const serverUrl = ($("serverUrl").value || "").trim();
  if (!serverUrl) {
    msg.className = "err";
    msg.textContent = "请填写电台地址";
    return;
  }
  try {
    await chrome.storage.local.set({ serverUrl });
    msg.textContent = "✓ 已保存";
  } catch (e) {
    msg.className = "err";
    msg.textContent = "保存失败";
  }
}

$("save").addEventListener("click", save);
loadAll();
