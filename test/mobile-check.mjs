// Phone-sized check for the server's own pages: the login form, the instance
// list, and the "instance offline" page. It creates a tunnel, drops it, and
// waits for the server to mark the instance offline, so the error page is
// exercised exactly as a phone opening /i/<id>/ would see it. The instance is
// removed afterwards.
//
// Usage: node test/mobile-check.mjs [server] [user] [password]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

import { chromium, devices } from "playwright-core";
import WebSocket from "ws";

const [server = "http://127.0.0.1:9830", user = "admin", password = "test-password-123"] = process.argv.slice(2);
const EDGE = process.env.DSHOO_BROWSER
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const shots = new URL("../.run/shots/", import.meta.url).pathname.replace(/^\//u, "");
mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

async function post(path, body, extraHeaders = {}) {
  return fetch(new URL(path, server), {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "dshoo", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

// A fresh database answers 428 everywhere until the first account exists.
const setup = await post("/api/setup", { username: user, password });
const session = setup.ok ? setup : await post("/api/auth/login", { username: user, password });
assert.ok(session.ok, `login failed: ${session.status}`);
const pair = session.headers.getSetCookie()[0].split(";")[0];
const index = pair.indexOf("=");
const cookie = {
  name: pair.slice(0, index),
  value: pair.slice(index + 1),
  domain: new URL(server).hostname,
  path: "/",
  httpOnly: true,
};

// Register a tunnel, then drop it and wait for the offline transition.
const ws = new WebSocket(new URL("/tunnel", server).href.replace(/^http/u, "ws"), {
  headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` },
});
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
ws.send(JSON.stringify({
  key: "mobile-check",
  name: "mobile-check",
  hostname: "pixel",
  os: "android",
  arch: "arm64",
  dshVersion: "0.2.1-rc.2",
  pid: process.pid,
  guiPort: 3099,
  pluginVersion: "1.0.1",
}));
const instanceId = await new Promise((resolve, reject) => {
  ws.once("message", (data, isBinary) => {
    if (isBinary) return reject(new Error("expected a text hello-ack"));
    const ack = JSON.parse(data.toString("utf8"));
    if (ack.type !== "hello-ack") return reject(new Error(`unexpected ${ack.type}`));
    resolve(ack.instanceId);
  });
});
ws.close();

const deadline = Date.now() + 45_000;
let offline = false;
while (Date.now() < deadline) {
  const response = await fetch(new URL(`/api/instances/${instanceId}`, server), { headers: { cookie: pair } });
  if (response.ok) {
    const view = await response.json();
    if (view.online === false) {
      offline = true;
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check("instance went offline", offline, instanceId);

const browser = await chromium.launch({ executablePath: EDGE, headless: true });

/** Phone contexts fail loudly when a page forgets its viewport meta: the
 *  layout viewport falls back to 980px and the text renders tiny. */
async function pageFits(page) {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
}

const phone = await browser.newContext({ ...devices["Pixel 7"] });
const { width } = devices["Pixel 7"].viewport;

// --- signed out ------------------------------------------------------------
const login = await phone.newPage();
await login.goto(new URL("/login", server).href, { waitUntil: "networkidle" });
let size = await pageFits(login);
check("login uses the phone viewport", size.viewport === width, `${size.viewport}px`);
check("login does not scroll sideways", size.scroll <= size.client + 1, `${size.scroll}px`);
check("login form visible", await login.locator("input[name=password]").isVisible());
await login.screenshot({ path: `${shots}mobile-login.png` });

// --- signed in: the list ---------------------------------------------------
await phone.addCookies([cookie]);
const page = await phone.newPage();
await page.goto(server, { waitUntil: "networkidle" });
await page.waitForSelector(".card, .empty");
size = await pageFits(page);
check("list uses the phone viewport", size.viewport === width, `${size.viewport}px`);
check("list does not scroll sideways", size.scroll <= size.client + 1, `${size.scroll}px`);

const remove = page.locator(".card", { hasText: "mobile-check" }).locator("xpath=..").locator(".remove");
check("touch shows the remove action", await remove.isVisible());

// The list groups by presence, and each heading counts its own cards.
check("offline instances sit in their own group", await page.locator("#offline-group").isVisible());
const offlineCards = await page.locator("#offline-group .card").count();
const offlineCount = (await page.locator("#offline-count").textContent()).trim();
check("the group heading counts its cards", offlineCount === String(offlineCards), `${offlineCount} vs ${offlineCards}`);
if (await page.locator("#online-group").isVisible()) {
  const onlineCards = await page.locator("#online-group .card").count();
  const onlineCount = (await page.locator("#online-count").textContent()).trim();
  check("the online heading counts its cards", onlineCount === String(onlineCards), `${onlineCount} vs ${onlineCards}`);
}
await page.screenshot({ path: `${shots}mobile-instances.png` });

// --- the offline page ------------------------------------------------------
const offlinePage = await phone.newPage();
await offlinePage.goto(new URL(`/i/${instanceId}/`, server).href, { waitUntil: "networkidle" });
await offlinePage.waitForSelector(".embed-error", { timeout: 20000 });
size = await pageFits(offlinePage);
check("offline page uses the phone viewport", size.viewport === width, `${size.viewport}px`);
check("offline page does not scroll sideways", size.scroll <= size.client + 1, `${size.scroll}px`);
check("offline page offers a way back", await offlinePage.locator(".embed-error .btn").isVisible());
await offlinePage.screenshot({ path: `${shots}mobile-offline.png` });

await browser.close();

// Keep the instance list clean for the next run.
await fetch(new URL(`/api/instances/${instanceId}`, server), {
  method: "DELETE",
  headers: { cookie: pair, "x-requested-with": "dshoo" },
});

console.log(failures === 0 ? "\nall mobile checks passed" : `\n${failures} mobile check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
