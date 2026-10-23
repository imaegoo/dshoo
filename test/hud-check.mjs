// Browser check for the remote page's HUD (back button + latency pill).
//
// It does not need a dshoo server or a harness: the test serves the rewritten
// index, the HUD script and a ping endpoint that replies after a delay, then
// asserts the pill's number, colour, placement and phone layout.
//
// Usage: node test/hud-check.mjs
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";

import { chromium, devices } from "playwright-core";

import { hudScript, rewriteIndex } from "../src/plugin/lib/bridge.js";

const EDGE = process.env.DSHOO_BROWSER
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const shots = new URL("../.run/shots/", import.meta.url).pathname.replace(/^\//u, "");
mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const fixture = "<!doctype html><html><head><meta charset=\"utf-8\">"
  + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
  + "<title>t</title></head><body><h1>hello</h1></body></html>";
const remotePage = rewriteIndex(fixture, "/i/abc");
const script = hudScript();

/** Ping delay the fake instance uses, switched between assertions. */
let pingDelay = 40;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/i/abc/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(remotePage);
    return;
  }
  if (url.pathname === "/i/abc/__dshoo/hud.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(script);
    return;
  }
  if (url.pathname === "/i/abc/__dshoo/ping") {
    setTimeout(() => {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
    }, pingDelay);
    return;
  }
  if (url.pathname === "/local/") {
    // What the harness serves when opened directly: no HUD.
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixture);
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const origin = `http://127.0.0.1:${String(port)}`;

const browser = await chromium.launch({ executablePath: EDGE, headless: true });

/** Read the pill's state and text, piercing the shadow root. */
async function readHud(page) {
  const hud = page.locator(".hud");
  return {
    visible: await hud.isVisible(),
    state: await hud.getAttribute("data-state"),
    number: (await page.locator(".num").textContent())?.trim() ?? "",
    backText: await page.locator(".back span").isVisible(),
    unit: await page.locator(".unit").isVisible(),
    box: await hud.boundingBox(),
  };
}

async function waitForNumber(page) {
  await page.waitForFunction(() => {
    const host = document.getElementById("dshoo-hud");
    const num = host?.shadowRoot?.querySelector(".num");
    return num !== null && num !== undefined && /^\d+$/u.test(num.textContent ?? "");
  }, undefined, { timeout: 8000 }).catch(() => {});
}

const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await desktop.newPage();
await page.goto(`${origin}/i/abc/`, { waitUntil: "networkidle" });
await waitForNumber(page);
let hud = await readHud(page);
check("pill renders", hud.visible);
check("quick link is green", hud.state === "good", `state ${hud.state}, ${hud.number}ms`);
check("number is milliseconds", Number(hud.number) > 0 && Number(hud.number) < 120, `${hud.number}ms`);
check("sits 16px from the top-left", Math.abs((hud.box?.x ?? 0) - 16) <= 1 && Math.abs((hud.box?.y ?? 0) - 16) <= 1,
  `${Math.round(hud.box?.x ?? 0)}, ${Math.round(hud.box?.y ?? 0)}`);
check("back points at the list", await page.locator(".back").getAttribute("href") === "/");
check("back label is visible on desktop", hud.backText);
await page.screenshot({ path: `${shots}hud-desktop.png` });

pingDelay = 200;
await page.reload({ waitUntil: "networkidle" });
await waitForNumber(page);
hud = await readHud(page);
check("200ms is amber", hud.state === "warn", `state ${hud.state}, ${hud.number}ms`);

pingDelay = 480;
await page.reload({ waitUntil: "networkidle" });
await waitForNumber(page);
hud = await readHud(page);
check("480ms is red", hud.state === "bad", `state ${hud.state}, ${hud.number}ms`);

// A page served directly by the harness must not get the HUD.
const local = await desktop.newPage();
await local.goto(`${origin}/local/`, { waitUntil: "networkidle" });
check("local page has no pill", await local.locator("#dshoo-hud").count() === 0);
await desktop.close();

// --- phone ---------------------------------------------------------------
const phone = await browser.newContext({ ...devices["Pixel 7"] });
const mobile = await phone.newPage();
await mobile.goto(`${origin}/i/abc/`, { waitUntil: "networkidle" });
await waitForNumber(mobile);
hud = await readHud(mobile);
check("phone keeps the pill", hud.visible);
check("phone drops the back label", !hud.backText);
check("phone drops the unit", !hud.unit);
check("phone pill is compact", (hud.box?.width ?? 0) < 120, `${Math.round(hud.box?.width ?? 0)}px wide`);
await mobile.screenshot({ path: `${shots}hud-phone.png` });
await phone.close();

await browser.close();
server.close();

console.log(failures === 0 ? "\nall HUD checks passed" : `\n${failures} HUD check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
