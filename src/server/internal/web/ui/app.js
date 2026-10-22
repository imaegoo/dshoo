"use strict";

/* Instance shell: sidebar list, selected instance rendered in the stage, and
   the harness UI itself served through the tunnel under /i/<id>/. */

const els = {
  list: document.getElementById("list"),
  summary: document.getElementById("summary"),
  who: document.getElementById("who"),
  avatar: document.getElementById("avatar"),
  logout: document.getElementById("logout"),
  refresh: document.getElementById("refresh"),
  head: document.getElementById("head"),
  dot: document.getElementById("dot"),
  title: document.getElementById("title"),
  meta: document.getElementById("meta"),
  reload: document.getElementById("reload"),
  popout: document.getElementById("popout"),
  stage: document.getElementById("stage"),
  frame: document.getElementById("frame"),
  empty: document.getElementById("empty"),
  emptyTitle: document.getElementById("empty-title"),
  emptyText: document.getElementById("empty-text"),
  emptySteps: document.getElementById("empty-steps"),
  toast: document.getElementById("toast"),
};

let instances = [];
let selected = "";
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
  return bits.join("/") || "";
}

/* ---------- rendering ---------- */

function renderList() {
  els.list.textContent = "";
  const online = instances.filter((item) => item.online).length;
  els.summary.textContent = instances.length === 0
    ? "实例"
    : `${online}/${instances.length} 在线`;

  if (instances.length === 0) {
    els.empty.hidden = false;
    els.head.hidden = true;
    els.frame.hidden = true;
    els.emptyTitle.textContent = "还没有实例";
    els.emptyText.textContent = "在需要纳管的机器上安装插件并连接，实例就会出现在这里。";
    els.emptySteps.hidden = false;
    return;
  }

  for (const item of instances) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.dataset.id = item.id;
    row.setAttribute("aria-current", item.id === selected ? "true" : "false");
    row.title = `${item.name}${item.hostname ? ` · ${item.hostname}` : ""}`;

    const dot = document.createElement("span");
    dot.className = "dot" + (item.online ? " on" : "");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.name;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = item.online ? "" : relativeTime(item.lastSeen);

    row.append(dot, name, meta);

    if (!item.online) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.title = "移除记录";
      remove.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      remove.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm(`移除「${item.name}」？设备重新连接后会再次出现。`)) return;
        try {
          await api(`/api/instances/${encodeURIComponent(item.id)}`, { method: "DELETE" });
          if (selected === item.id) select("");
          await load();
        } catch (error) {
          toast(error.message);
        }
      });
      row.append(remove);
    }

    row.addEventListener("click", () => select(item.id));
    els.list.append(row);
  }
}

function renderStage() {
  const item = instances.find((candidate) => candidate.id === selected);
  if (item === undefined) {
    els.head.hidden = true;
    els.frame.hidden = true;
    els.empty.hidden = false;
    if (instances.length > 0) {
      els.emptyTitle.textContent = "选择一个实例";
      els.emptyText.textContent = "从左侧选择一个实例，它的 DeepSeek Harness 界面会在这里打开。";
      els.emptySteps.hidden = true;
    }
    return;
  }

  els.empty.hidden = true;
  els.head.hidden = false;
  els.frame.hidden = false;
  els.dot.className = "dot" + (item.online ? " on" : "");
  els.title.textContent = item.name;
  const bits = [platformLabel(item), item.dshVersion ? `DSH ${item.dshVersion}` : "",
    item.online ? "在线" : "离线"].filter(Boolean);
  els.meta.textContent = bits.join(" · ");

  const src = `/i/${encodeURIComponent(item.id)}/`;
  els.popout.href = src;
  if (els.frame.getAttribute("src") !== src) {
    els.frame.src = src;
  }
}

function select(id, push = true) {
  selected = id;
  if (push) {
    const hash = id === "" ? "" : `#/${id}`;
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
  }
  for (const row of els.list.querySelectorAll(".row")) {
    row.setAttribute("aria-current", row.dataset.id === selected ? "true" : "false");
  }
  renderStage();
}

/* ---------- data ---------- */

async function load() {
  const data = await api("/api/instances");
  instances = data.instances || [];
  if (selected !== "" && !instances.some((item) => item.id === selected)) selected = "";
  renderList();
  renderStage();
}

function subscribe() {
  const source = new EventSource("/api/events");
  source.addEventListener("instance", (event) => {
    const payload = (() => {
      try { return JSON.parse(event.data); } catch { return {}; }
    })();
    const changed = instances.find((item) => item.id === payload.instanceId);
    if (changed !== undefined) {
      changed.online = payload.online === true;
      renderList();
      if (selected === changed.id) renderStage();
    }
    load().catch(() => {});
  });
  source.addEventListener("instances", () => { load().catch(() => {}); });
}

async function boot() {
  const me = await api("/api/me");
  const username = me.user.username;
  els.who.textContent = username;
  els.avatar.textContent = username.slice(0, 1).toUpperCase();

  const hash = location.hash.replace(/^#\/?/u, "");
  selected = hash;
  await load();
  if (selected === "" && instances.length === 1) select(instances[0].id, false);

  subscribe();

  els.refresh.addEventListener("click", () => { load().catch((error) => toast(error.message)); });
  els.reload.addEventListener("click", () => {
    if (selected === "") return;
    els.frame.src = `/i/${encodeURIComponent(selected)}/`;
  });
  els.logout.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // The redirect below is correct either way.
    }
    location.replace("/login");
  });

  // Keep "last seen" labels honest without refetching on every tick.
  setInterval(() => {
    if (instances.some((item) => !item.online)) renderList();
  }, 60000);
}

boot().catch((error) => {
  if (error.message !== "unauthorized" && error.message !== "setup required") toast(error.message);
});
