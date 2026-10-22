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

/** Open the settings dialog and land on the remote-access section. */
const openSection = async () => {
  await page.locator('[aria-label*="账号菜单"], [aria-label*="Account"]').first().click();
  await page.waitForTimeout(700);
  const item = page.getByText("设置", { exact: true }).first();
  if (await item.count() > 0) {
    await item.click();
    await page.waitForTimeout(900);
  }
  const section = page.getByText("远程访问", { exact: true }).first();
  if (await section.count() > 0) {
    await section.click();
    await page.waitForTimeout(900);
  }
};

await openSection();

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

  // Regression: a half-typed password must never be saved or cleared. The
  // typed value is passed in so the run leaves the stored secret unchanged.
  const password = process.argv[3];
  if (password) {
    await page.waitForTimeout(2000); // let the previous "已保存" note expire
    const passwordInput = page.locator(".dshoo input[type=password]");
    await passwordInput.click();
    await passwordInput.pressSequentially(password, { delay: 120 });
    check("password keeps the typed text", await passwordInput.inputValue() === password);
    check("no autosave while typing the password", await page.locator(".dshoo-note").count() === 0);

    // Past the 700ms debounce window, still untouched and still unsaved.
    await page.waitForTimeout(1200);
    check("password survives the debounce window", await passwordInput.inputValue() === password);
    check("still no autosave", await page.locator(".dshoo-note").count() === 0);

    // Leaving the field commits it, and only then is the box cleared.
    await page.locator(".dshoo input").first().click();
    await page.waitForTimeout(1500);
    check("password saves on blur", await page.locator(".dshoo-note").count() > 0);
    check("password box cleared after blur", await passwordInput.inputValue() === "");
    const afterPassword = await readState();
    check("server still holds a password", afterPassword.config.hasPassword === true);
  } else {
    console.log("note: pass the password as the second argument to exercise the password autosave regression");
  }

  // Regression: reopening the page must show the stored configuration, not an
  // empty form.
  const readInputs = async () => page.locator(".dshoo input").evaluateAll((nodes) => nodes.map((node) => node.value));
  const beforeValues = await readInputs();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  await openSection();
  const afterValues = await readInputs();
  check("form refills after reopening",
    afterValues[0] === beforeValues[0] && afterValues[1] === beforeValues[1] && afterValues[0] !== "",
    `${JSON.stringify(afterValues.slice(0, 2))}`);
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
