// End-to-end check against a running dshoo server + connected instance.
// Usage: node test/e2e.mjs <server> <user> <password>
import WebSocket from "ws";

const [server = "http://127.0.0.1:9830", user = "admin", password = "test-password-123"] = process.argv.slice(2);

let cookie = "";
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function call(path, init = {}) {
  const response = await fetch(new URL(path, server), {
    ...init,
    redirect: "manual",
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  return response;
}

async function login() {
  const response = await call("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "dshoo" },
    body: JSON.stringify({ username: user, password }),
  });
  const setCookie = response.headers.getSetCookie();
  cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
  check("login", response.ok && cookie.includes("dshoo_session"), `status ${response.status}`);
}

/**
 * A fresh server has no account yet: the first visit creates one. Both paths
 * are exercised because the same command runs against a fresh and a warm DB.
 */
async function ensureAccount() {
  const setup = await call("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "dshoo" },
    body: JSON.stringify({ username: user, password }),
  });
  if (setup.ok) {
    cookie = setup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    check("first-run setup", cookie.includes("dshoo_session"), `status ${setup.status}`);
    return;
  }
  check("setup refuses a second account", setup.status === 409, `status ${setup.status}`);
  await login();
}

async function listInstances() {
  const response = await call("/api/instances");
  const body = await response.json();
  check("instances listed", response.ok && body.total >= 1, `total ${body.total}`);
  const online = body.instances.find((item) => item.online);
  check("instance online", online !== undefined);
  return online;
}

async function fetchIndex(instance) {
  const response = await call(`/i/${instance.id}/`);
  const html = await response.text();
  check("index proxied", response.ok && html.includes("<html"), `status ${response.status} bytes ${html.length}`);
  // This harness release emits relative module URLs; older ones emit
  // root-absolute URLs, which the plugin prefixes. Accept either.
  const relative = html.includes('src="plugins/');
  const prefixed = html.includes(`/i/${instance.id}/plugins/`);
  check("module urls resolve under the prefix", relative || prefixed, relative ? "relative" : prefixed ? "prefixed" : "neither");
  check("index has base", html.includes("<base"));
  return html;
}

async function fetchBundle(instance, html) {
  const match = /"((?:\.\/|\/i\/[^"]*\/)?plugins\/[^"]+?)"/u.exec(html);
  if (match === null) {
    check("plugin bundle path found", false);
    return;
  }
  const target = match[1].startsWith("/")
    ? match[1]
    : `/i/${instance.id}/${match[1].replace(/^\.\//u, "")}`;
  const decoded = target.replace(/&amp;/gu, "&");
  const response = await call(decoded);
  const body = await response.text();
  check("plugin bundle proxied", response.ok && body.length > 1000, `bytes ${body.length}`);
  check("plugin bundle is javascript", (response.headers.get("content-type") ?? "").includes("javascript"));
}

async function socketCheck(instance) {
  const url = new URL(`/i/${instance.id}/api/remote.mux`, server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie, origin: server },
    perMessageDeflate: false,
  });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: true, detail: "stayed open" }), 2500);
    socket.on("open", () => {});
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `HTTP ${response.statusCode}` });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: error.message });
    });
    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `closed ${code}` });
    });
  });
  socket.terminate();
  check("websocket proxied", result.ok, result.detail);
}

await ensureAccount();
const instance = await listInstances();
if (instance !== undefined) {
  const html = await fetchIndex(instance);
  await fetchBundle(instance, html);
  await socketCheck(instance);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
