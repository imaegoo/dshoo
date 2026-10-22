"use strict";

/* Instance list: one card per instance, three per row. Clicking a card opens
   that instance's own page; the harness UI itself is loaded there, not here. */

const els = {
  grid: document.getElementById("grid"),
  summary: document.getElementById("summary"),
  empty: document.getElementById("empty"),
  who: document.getElementById("who-name"),
  avatar: document.getElementById("avatar"),
  refresh: document.getElementById("refresh"),
  logout: document.getElementById("logout"),
  toast: document.getElementById("toast"),
};

let instances = [];
let toastTimer = 0;

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3000);
}

async function api(path, options) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "x-requested-with": "dshoo", "content-type": "application/json" },
    ...options,
  });
  if (response.status === 401) {
    location.replace("/login");
    throw new Error("unauthorized");
  }
  if (response.status === 428) {
    location.replace("/setup");
    throw new Error("setup required");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function relativeTime(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function platformLabel(item) {
  const bits = [item.os, item.arch].filter(Boolean);
  return bits.join("/") || "系统未知";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detailLine(label, value) {
  const line = el("div", "card-line");
  line.append(el("span", null, label), el("span", null, value));
  return line;
}

function card(item) {
  const link = el("a", "card");
  // The card opens the instance's real harness UI directly: there is no
  // wrapper page, the control plane hands the browser to /i/<id>/.
  link.href = `/i/${encodeURIComponent(item.id)}/`;
  link.title = `打开 ${item.name}`;

  const top = el("div", "card-top");
  top.append(el("span", "dot" + (item.online ? " on" : "")));
  top.append(el("span", "card-name", item.name));
  const arrow = el("span", "card-arrow");
  arrow.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M7 17 17 7M9 7h8v8"/></svg>';
  top.append(arrow);

  const lines = el("div", "card-lines");
  lines.append(detailLine("系统", platformLabel(item)));
  lines.append(detailLine("版本", item.dshVersion ? `dsh ${item.dshVersion}` : "dsh 版本未知"));

  const foot = el("div", "card-foot");
  if (item.online) {
    foot.append(el("span", "online", "在线"), el("span", null, `· ${relativeTime(item.connectedAt) || "刚刚"}上线`));
  } else {
    foot.append(el("span", null, item.lastSeen ? `离线 · ${relativeTime(item.lastSeen)}在线` : "离线"));
  }

  link.append(top, lines, foot);

  const wrap = el("div", "card-wrap");
  wrap.append(link);

  if (!item.online) {
    const remove = el("button", "remove", "移除");
    remove.type = "button";
    remove.title = "从列表中移除这条记录";
    remove.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!confirm(`移除「${item.name}」？设备重新连接后会再次出现。`)) return;
      try {
        await api(`/api/instances/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        await load();
      } catch (error) {
        toast(error.message);
      }
    });
    wrap.append(remove);
  }

  return wrap;
}

function render() {
  els.grid.textContent = "";
  const online = instances.filter((item) => item.online).length;

  if (instances.length === 0) {
    els.summary.textContent = "暂无实例";
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  els.summary.textContent = `${online} 在线 / 共 ${instances.length}`;
  for (const item of instances) els.grid.append(card(item));
}

async function load() {
  const data = await api("/api/instances");
  instances = data.instances || [];
  render();
}

function subscribe() {
  const source = new EventSource("/api/events");
  source.addEventListener("instance", () => { load().catch(() => {}); });
  source.addEventListener("instances", () => { load().catch(() => {}); });
  // EventSource reconnects on its own.
}

async function boot() {
  const me = await api("/api/me");
  const username = me.user.username;
  els.who.textContent = username;
  els.avatar.textContent = username.slice(0, 1).toUpperCase();

  await load();
  subscribe();

  els.refresh.addEventListener("click", () => { load().catch((error) => toast(error.message)); });
  els.logout.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // The redirect below is correct either way.
    }
    location.replace("/login");
  });

  setInterval(() => { load().catch(() => {}); }, 30000);
}

boot().catch((error) => {
  if (error.message !== "unauthorized" && error.message !== "setup required") toast(error.message);
});
