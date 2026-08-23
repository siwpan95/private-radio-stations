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
let _lyricKey = null;
let _lyricLines = [];

async function api(path, opts) {
  const base = await getBase();
  return fetch(base + path, opts);
}

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
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

  $("mode").textContent =
    s.mode === "relay" ? "转播中" : s.mode === "musickit" ? "随机渲染" : "本地歌单";
  $("title").textContent = s.current_title || "—";
  $("sub").textContent =
    s.mode === "relay"
      ? "来源：" + (s.relay_url || "—")
      : s.mode === "musickit"
      ? "musickit 随机渲染中"
      : s.paused
      ? "已暂停"
      : "本地歌单播放中";

  // 封面（仅 playlist 有内嵌封面）
  const cover = $("cover");
  if (s.mode === "playlist" && s.current_title) {
    cover.innerHTML = `<img src="${await getBase()}/api/cover?t=${Date.now()}" alt="cover" onerror="this.parentNode.innerHTML='<div class=\\'cover-empty\\'>♪</div>'">`;
  } else {
    cover.innerHTML = '<div class="cover-empty">♪</div>';
  }

  $("playpause").textContent = s.paused ? "▶" : "⏸";
  loadLyrics(s);
}

// ---------- C2 歌词 ----------
async function loadLyrics(s) {
  if (!s) s = _status;
  if (!s) return;
  const key = (s.mode === "relay" ? "relay:" : "pl:") + (s.current_title || "");
  if (key !== _lyricKey) {
    _lyricKey = key;
    _lyricLines = [];
    $("lyricBadge").hidden = true;
    $("lyrics").innerHTML = '<div class="empty">加载中…</div>';
    try {
      const r = await (await api("/api/lyrics")).json();
      renderLyrics(r);
    } catch (e) {
      $("lyrics").innerHTML = '<div class="empty">歌词加载失败</div>';
    }
  }
  tickLyrics();
}

function renderLyrics(r) {
  const box = $("lyrics");
  if (!r || (!r.lines.length && !r.plain)) {
    box.innerHTML = '<div class="empty">（暂无歌词）</div>';
    _lyricLines = [];
    return;
  }
  if (r.synced && r.lines.length) {
    $("lyricBadge").hidden = false;
    _lyricLines = r.lines;
    box.innerHTML = r.lines
      .map((l, i) => `<div class="line" data-i="${i}">${esc(l.text)}</div>`)
      .join("");
  } else {
    $("lyricBadge").hidden = true;
    _lyricLines = [];
    box.innerHTML = `<div class="plain">${esc(r.plain || "")}</div>`;
  }
}

function tickLyrics() {
  if (!_lyricLines.length) return;
  const t = _status && typeof _status.elapsed === "number" ? _status.elapsed : 0;
  let cur = -1;
  for (let i = 0; i < _lyricLines.length; i++) {
    if (t >= _lyricLines[i].t) cur = i;
    else break;
  }
  if (cur < 0) return;
  const box = $("lyrics");
  const nodes = box.querySelectorAll(".line");
  if (cur >= nodes.length) return;
  for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle("active", i === cur);
  const el = nodes[cur];
  box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
}

// ---------- 控制 ----------
async function postApi(path) {
  try {
    await api(path, { method: "POST", headers: { "Content-Type": "application/json" } });
  } catch (e) {}
  refresh();
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
$("playpause").addEventListener("click", () => postApi("/api/pause"));
$("prev").addEventListener("click", () => postApi("/api/next"));
$("announce").addEventListener("click", async () => {
  try {
    const r = await (await api("/api/announce", { method: "POST" })).json();
    $("status").textContent = r.ok ? "已发布到 Discord/Telegram ✓" : "未配置凭据（去 ⚙ 设置）";
  } catch (e) {}
});
$("openOptions").addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

// 启动：刷新 + 每 2s 拉状态 + 每 250ms 歌词高亮
refresh();
setInterval(refresh, 2000);
setInterval(tickLyrics, 250);
