// Inspect the harness GUI directly (bypassing the tunnel) to find the settings
// entry, then verify the plugin's 远程访问 section: fields, auto-save, the two
// connection buttons, and that closing the page leaves the tunnel up.
//
// Usage: node test/plugin-ui-check.mjs <token-url>
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const EDGE = process.env.DSHOO_BROWSER
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const shots = new URL("../.run/shots/", import.meta.url).pathname.replace(/^\//u, "");
mkdirSync(shots, { recursive: true });

const target = process.argv[2];
if (!target) {
  console.error("usage: node test/plugin-ui-check.mjs <http://host/?token=...>");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const stateUrl = new URL("/remote-access/api/state", target).href;
const readState = async () => {
  const response = await fetch(stateUrl);
  return response.json();
};

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.goto(target, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#root > *", { timeout: 30000 });
await page.waitForTimeout(1500);

// Close the release-notes dialog if the build shows one on first run.
for (const label of ["继续", "Continue"]) {
  const button = page.getByRole("button", { name: label });
  if (await button.count() > 0) {
    await button.first().click().catch(() => {});
    await page.waitForTimeout(400);
    break;
  }
}

const settingsButton = page.locator('[aria-label*="设置"], [title*="设置"], [aria-label*="Settings"], [title*="Settings"], [aria-label*="账号菜单"], [aria-label*="Account"]').first();
const hasSettings = await settingsButton.count() > 0;
check("settings entry exists", hasSettings);
if (!hasSettings) {
  console.log("\nno settings entry found; page text sample:");
  console.log((await page.locator("body").innerText()).slice(0, 400));
  await browser.close();
  process.exit(1);
}

await settingsButton.click();
await page.waitForTimeout(900);

// The account menu opens the settings surface in this release.
const settingsItem = page.getByText("设置", { exact: true }).first();
if (await settingsItem.count() > 0) {
  await settingsItem.click();
  await page.waitForTimeout(900);
}

const remoteSection = page.getByText("远程访问", { exact: true }).first();
check("远程访问 section registered", await remoteSection.count() > 0);
if (await remoteSection.count() > 0) {
  await remoteSection.click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${shots}remote-access.png` });

  const text = await page.locator("body").innerText();
  check("section renders fields", text.includes("服务端地址") && text.includes("用户名"));
  check("section shows connection state", /已连接|未连接|连接中|连接失败/u.test(text));
  check("no save button", !text.includes("保存配置"));

  // Exactly one connection button, and it carries the connect/disconnect class
  // the stylesheet colours blue or red.
  const connect = await page.locator(".dshoo button.connect").count();
  const disconnect = await page.locator(".dshoo button.disconnect").count();
  check("one connection button", connect + disconnect === 1, `connect=${connect} disconnect=${disconnect}`);
  const buttonColor = await page.locator(".dshoo button.connect, .dshoo button.disconnect")
    .first().evaluate((element) => getComputedStyle(element).backgroundColor);
  check("button is coloured", /rgb/u.test(buttonColor), buttonColor);

  // Auto-save: type the instance name (fourth field), wait for the debounce,
  // read the host state back.
  const nameInput = page.locator(".dshoo input").nth(3);
  const marker = `autosave-${Date.now()}`;
  await nameInput.fill(marker);
  await page.waitForTimeout(1600);
  const state = await readState();
  check("field autosaves", state.config.name === marker, state.config.name);

  // Restore the name so the screenshot and later runs stay stable.
  await nameInput.fill("test-lab");
  await page.waitForTimeout(1600);
}

// Closing the settings page must not drop the tunnel.
const before = await readState();
await page.keyboard.press("Escape");
await page.waitForTimeout(1500);
const after = await readState();
check("connection survives leaving the page",
  after.status.state === before.status.state,
  `${before.status.state} -> ${after.status.state}`);
check("tunnel still connected", after.status.state === "connected", after.status.state);

if (errors.length > 0) {
  console.log("\nconsole errors:");
  for (const message of errors.slice(0, 10)) console.log(`  ${message}`);
}
check("no console errors", errors.length === 0, `${errors.length} message(s)`);

await browser.close();
console.log(failures === 0 ? "\nall plugin UI checks passed" : `\n${failures} plugin UI check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
