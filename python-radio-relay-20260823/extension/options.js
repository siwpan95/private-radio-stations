"use strict";

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "http://localhost:8000";

// 读取：扩展本地存 serverUrl；服务器存 integrations 配置
async function loadAll() {
  try {
    const v = await chrome.storage.local.get("serverUrl");
    $("serverUrl").value = (v && v.serverUrl) || DEFAULT_SERVER;
  } catch (e) {
    $("serverUrl").value = DEFAULT_SERVER;
  }
  try {
    const base = await getBase();
    const r = await fetch(base + "/api/integrations");
    const j = await r.json();
    // 服务器只回布尔，凭据需用户重新填（不回显，安全）
    $("enabled").checked = !!j.enabled;
  } catch (e) {
    /* 连不上服务器也能先存地址 */
  }
}

async function getBase() {
  try {
    const v = await chrome.storage.local.get("serverUrl");
    if (v && v.serverUrl) return v.serverUrl.replace(/\/+$/, "");
  } catch (e) {}
  return DEFAULT_SERVER;
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
  const cfg = {
    enabled: $("enabled").checked,
    discord_webhook: ($("discord_webhook").value || "").trim(),
    telegram_token: ($("telegram_token").value || "").trim(),
    telegram_chat_id: ($("telegram_chat_id").value || "").trim(),
  };

  // 存到扩展本地
  try {
    await chrome.storage.local.set({ serverUrl });
  } catch (e) {}

  // 推到服务器 integrations.json
  try {
    const base = serverUrl.replace(/\/+$/, "");
    const r = await fetch(base + "/api/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (!r.ok) throw new Error("server");
    msg.textContent = "✓ 已保存到扩展与服务器";
  } catch (e) {
    msg.className = "err";
    msg.textContent = "地址已存扩展，但服务器写入失败（确认电台已启动）";
  }
}

$("save").addEventListener("click", save);
loadAll();
