// Real-browser check: creates the first account when the server is fresh, logs
// in, opens the instance list, selects an instance and asserts the harness GUI
// actually boots inside the embedded frame. Screenshots land in .run/shots/.
//
// Usage: node test/browser-check.mjs [server] [user] [password]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

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

async function post(path, body) {
  return fetch(new URL(path, server), {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "dshoo" },
    body: JSON.stringify(body),
  });
}

// A fresh database answers 428 everywhere until the first account exists.
const setup = await post("/api/setup", { username: user, password });
check("setup or existing account", setup.ok || setup.status === 409, `status ${setup.status}`);
const login = setup.ok ? setup : await post("/api/auth/login", { username: user, password });
check("login", login.ok, `status ${login.status}`);
const cookieHeader = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
const session = cookieHeader.split(";").map((part) => {
  const [name, ...rest] = part.trim().split("=");
  return { name, value: rest.join("=") };
})[0];

const browser = await chromium.launch({ executablePath: EDGE, headless: true });

// --- signed out: the login page is the only reachable screen -----------------
const anonymous = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const loginPage = await anonymous.newPage();
await loginPage.goto(new URL("/", server).href, { waitUntil: "networkidle" });
check("anonymous visit lands on login", loginPage.url().endsWith("/login"), loginPage.url());
await loginPage.screenshot({ path: `${shots}login.png` });
check("login form rendered", await loginPage.locator("input[name=password]").count() === 1);
await anonymous.close();

// --- signed in ---------------------------------------------------------------
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.addCookies(session
  ? [{ ...session, domain: new URL(server).hostname, path: "/", httpOnly: true }]
  : []);

const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

await page.goto(new URL("/", server).href, { waitUntil: "networkidle" });
await page.waitForSelector(".card, .empty", { timeout: 15000 });
const cards = await page.locator(".card").count();
check("instance list renders", cards >= 1, `${cards} card(s)`);
check("instances are grouped", await page.locator(".group:not([hidden])").count() >= 1);
await page.screenshot({ path: `${shots}instances.png` });

// Open a live instance: an offline card leads to the proxy's own "instance
// offline" page, which is not what this check wants to exercise.
const online = page.locator(".card:has(.dot.on)").first();
const target = (await online.count()) > 0 ? online : page.locator(".card").first();
await target.click();
await page.waitForURL(/\/i\/[^/]+\//u, { timeout: 10000 }).catch(() => {});
check("card opens the instance UI directly", /\/i\/[^/]+\//u.test(page.url()), page.url());

// The harness renders its shell once the module graph boots and the mux
// handshake completes. The card list hands the browser straight to /i/<id>/,
// so the harness owns the top-level document here.
const SHELL_TEXT = /新会话|New session|探索未至之境|标准模式/u;
await page.waitForFunction((pattern) => {
  const root = document.querySelector("#root");
  return (root?.children.length ?? 0) > 0
    && new RegExp(pattern, "u").test(document.body.innerText);
}, SHELL_TEXT.source, { timeout: 45000 }).catch(() => {});
const pageText = await page.locator("body").innerText();
check("harness shell rendered", SHELL_TEXT.test(pageText),
  `${pageText.trim().slice(0, 40).replace(/\s+/gu, " ")}…`);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${shots}instance.png` });

if (consoleErrors.length > 0) {
  console.log("\nconsole errors:");
  for (const message of consoleErrors.slice(0, 12)) console.log(`  ${message}`);
}
check("no console errors", consoleErrors.length === 0, `${consoleErrors.length} message(s)`);

await browser.close();
console.log(failures === 0 ? "\nall browser checks passed" : `\n${failures} browser check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
