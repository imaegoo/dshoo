/**
 * The remote page's HUD: a back button and a live latency pill.
 *
 * Kept apart from the bridge because the pill is browser code that is
 * serialised into the page, and it dwarfs the proxy it rides on.
 */

/** Local endpoints the HUD uses; they never reach the harness. */
export const HUD_PING_PATH = "/__dshoo/ping";
export const HUD_SCRIPT_PATH = "/__dshoo/hud.js";

/** The browser script the remote page loads, served from the plugin. */
export function hudScript(): string {
  return `(${installHud.toString()})();`;
}

/** Put the HUD's script tag just before the closing body tag, once. */
export function injectHud(html: string, prefix: string): string {
  if (html.includes(HUD_SCRIPT_PATH)) return html;
  const tag = `<script src="${prefix}${HUD_SCRIPT_PATH}" defer></script>`;
  const closing = /<\/body>/iu.exec(html);
  if (closing === null) return `${html}${tag}`;
  return `${html.slice(0, closing.index)}${tag}${html.slice(closing.index)}`;
}

/**
 * Back button and latency pill for pages opened through a dshoo server.
 *
 * This function is serialised with `toString()` and runs in the browser, so it
 * must stay self-contained: no references to module scope, no imports. The
 * latency is measured by asking this plugin for a 204 over the tunnel; the
 * number therefore covers browser → server → tunnel and nothing else.
 */
function installHud(): void {
  if (document.getElementById("dshoo-hud") !== null) return;

  const host = document.createElement("div");
  host.id = "dshoo-hud";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
:host {
  all: initial;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483647;
  display: block;
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 12.5px;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
  /* Position is a transform so the snap can animate on the compositor. */
  transform: translate3d(16px, 16px, 0);
  transition: transform 240ms cubic-bezier(.22, .8, .24, 1);
  will-change: transform;
}
.hud {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 10px 0 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .72);
  border: .5px solid rgba(0, 0, 0, .08);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 6px 20px rgba(0, 0, 0, .07);
  -webkit-backdrop-filter: blur(16px) saturate(1.25);
  backdrop-filter: blur(16px) saturate(1.25);
  -webkit-user-select: none;
  user-select: none;
  cursor: grab;
  /* Touch drags must move the pill, not scroll the page underneath it. */
  touch-action: none;
  transition: box-shadow 160ms ease;
}
.hud.dragging {
  cursor: grabbing;
  box-shadow: 0 2px 6px rgba(0, 0, 0, .10), 0 16px 36px rgba(0, 0, 0, .16);
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 7px 0 4px;
  border-radius: 6px;
  color: #61666b;
  text-decoration: none;
  font-size: 12.5px;
  cursor: pointer;
  touch-action: manipulation;
}
.back:hover { background: rgba(0, 0, 0, .05); color: #0f1115; }
.back svg { display: block; }
.sep { width: 1px; height: 12px; margin: 0 8px 0 4px; background: rgba(0, 0, 0, .07); flex: none; }
.lat { display: inline-flex; align-items: center; gap: 7px; color: #adb2b8; }
.bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 11px; }
.bars i { width: 3px; border-radius: 1px; background: currentColor; opacity: .22; }
.bars i:nth-child(1) { height: 5px; }
.bars i:nth-child(2) { height: 8px; }
.bars i:nth-child(3) { height: 11px; }
.num {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: 12.5px;
  color: #0f1115;
  min-width: 3ch;
  text-align: right;
  letter-spacing: -.01em;
}
.unit { font-size: 10px; color: #81858c; margin-left: 1px; }
.hud[data-state="good"] .lat { color: #22c55e; }
.hud[data-state="good"] .bars i { opacity: 1; }
.hud[data-state="warn"] .lat { color: #f59e0b; }
.hud[data-state="warn"] .bars i:nth-child(-n+2) { opacity: 1; }
.hud[data-state="bad"] .lat { color: #ec1313; }
.hud[data-state="bad"] .bars i:nth-child(1) { opacity: 1; }
.hud[data-state="idle"] .num { color: #adb2b8; }
@media (prefers-color-scheme: dark) {
  .hud {
    background: rgba(27, 27, 28, .70);
    border-color: rgba(255, 255, 255, .12);
    box-shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 8px 24px rgba(0, 0, 0, .25);
  }
  .back { color: #cfd3d6; }
  .back:hover { background: rgba(255, 255, 255, .08); color: #f9fafb; }
  .sep { background: rgba(255, 255, 255, .10); }
  .num { color: #f9fafb; }
  .unit { color: #adb2b8; }
  .hud[data-state="idle"] .num { color: #81858c; }
  .hud[data-state="bad"] .lat { color: #f25a5a; }
}
@media (max-width: 620px) {
  .hud { padding: 0 9px 0 3px; }
  .back { padding: 0 5px; }
  .back span { display: none; }
  .unit { display: none; }
}
</style>
<div class="hud" data-state="idle">
  <a class="back" href="/" title="返回实例列表" aria-label="返回实例列表" draggable="false">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6"></path>
    </svg>
    <span>返回</span>
  </a>
  <span class="sep" aria-hidden="true"></span>
  <span class="lat" role="status" aria-label="链路延迟未知">
    <span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="num">—</span><span class="unit">ms</span>
  </span>
</div>`;

  const hud = root.querySelector(".hud") as HTMLElement | null;
  const num = root.querySelector(".num") as HTMLElement | null;
  const lat = root.querySelector(".lat") as HTMLElement | null;
  const back = root.querySelector(".back") as HTMLAnchorElement | null;
  if (hud === null || num === null || lat === null || back === null) return;
  document.body.appendChild(host);

  // ---- position: 16px from the nearest edge after every drag --------------
  let posX = 16;
  let posY = 16;
  let edge: "left" | "right" | "top" | "bottom" = "left";
  let dragging = false;
  let pointer = -1;
  let grabX = 0;
  let grabY = 0;
  let originX = 0;
  let originY = 0;

  const applyPosition = (animate: boolean): void => {
    host.style.transition = animate ? "" : "none";
    host.style.transform = `translate3d(${String(posX)}px, ${String(posY)}px, 0)`;
  };

  /** Keep the pill 16px from the edge it snapped to when its width changes. */
  const keepAnchored = (): void => {
    if (dragging) return;
    const rect = hud.getBoundingClientRect();
    if (edge === "right") {
      posX = Math.max(16, window.innerWidth - rect.width - 16);
      applyPosition(true);
    } else if (edge === "bottom") {
      posY = Math.max(16, window.innerHeight - rect.height - 16);
      applyPosition(true);
    }
  };

  /** Snap to the closest edge, leaving 16px, and animate the move. */
  const settle = (): void => {
    const rect = hud.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const dLeft = posX;
    const dRight = window.innerWidth - width - posX;
    const dTop = posY;
    const dBottom = window.innerHeight - height - posY;
    const nearest = Math.min(dLeft, dRight, dTop, dBottom);
    if (nearest === dLeft) {
      edge = "left";
      posX = 16;
    } else if (nearest === dRight) {
      edge = "right";
      posX = window.innerWidth - width - 16;
    } else if (nearest === dTop) {
      edge = "top";
      posY = 16;
    } else {
      edge = "bottom";
      posY = window.innerHeight - height - 16;
    }
    posX = Math.min(Math.max(posX, 0), Math.max(0, window.innerWidth - width));
    posY = Math.min(Math.max(posY, 0), Math.max(0, window.innerHeight - height));
    applyPosition(true);
  };

  const samples: number[] = [];
  let failures = 0;
  let timer: number | undefined;
  let running = false;
  let first = true;
  let started = false;

  const median = (values: number[]): number => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };

  const render = (value: number | undefined): void => {
    if (value === undefined || !Number.isFinite(value)) {
      hud.setAttribute("data-state", "idle");
      num.textContent = "—";
      lat.setAttribute("aria-label", "链路延迟未知");
      keepAnchored();
      return;
    }
    const ms = Math.max(1, Math.min(99999, Math.round(value)));
    hud.setAttribute("data-state", ms <= 120 ? "good" : ms <= 300 ? "warn" : "bad");
    num.textContent = String(ms);
    lat.setAttribute("aria-label", `链路延迟 ${String(ms)} 毫秒`);
    lat.setAttribute("title", `链路延迟 ${String(ms)} 毫秒`);
    keepAnchored();
  };

  const schedule = (delay = 5000): void => {
    if (document.visibilityState === "hidden") return;
    timer = window.setTimeout(() => { void probe(); }, delay);
  };

  const probe = async (): Promise<void> => {
    if (running || document.visibilityState === "hidden") return;
    running = true;
    const controller = new AbortController();
    const guard = window.setTimeout(() => { controller.abort(); }, 10000);
    const startedAt = performance.now();
    let next = 5000;
    try {
      const base = location.pathname.replace(/\/+$/u, "");
      const url = `${base}/__dshoo/ping?t=${String(Date.now())}`;
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      await response.arrayBuffer();
      // Resource Timing strips main-thread scheduling out of the number: while
      // the harness boots, a `performance.now()` delta can read 150ms on a 3ms
      // link.
      const entries = performance.getEntriesByName(url);
      const entry = entries[entries.length - 1] as PerformanceResourceTiming | undefined;
      const measured = entry !== undefined && entry.responseStart > 0
        ? entry.responseStart - entry.requestStart
        : performance.now() - startedAt;
      if (first) {
        // The first probe races the page's own boot traffic on the shared
        // tunnel; keep it out of the average and measure again in a second.
        first = false;
        next = 1000;
      } else {
        samples.push(measured);
        if (samples.length > 3) samples.shift();
        failures = 0;
        render(median(samples));
      }
    } catch {
      failures += 1;
      if (failures >= 2) render(undefined);
    } finally {
      window.clearTimeout(guard);
      running = false;
      schedule(next);
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    void probe();
  };
  if (document.readyState === "complete") {
    window.setTimeout(start, 200);
  } else {
    window.addEventListener("load", start, { once: true });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      window.clearTimeout(timer);
      void probe();
    }
  });
  window.addEventListener("online", () => { void probe(); });

  // ---- dragging ----------------------------------------------------------
  // Everywhere on the pill except the back button starts a drag; the back
  // button keeps its click and its native link behaviour.
  hud.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (back !== null && event.composedPath().includes(back)) return;
    dragging = true;
    pointer = event.pointerId;
    grabX = event.clientX;
    grabY = event.clientY;
    originX = posX;
    originY = posY;
    hud.classList.add("dragging");
    // No transition while the finger is down: the pill must track it exactly.
    host.style.transition = "none";
    try {
      hud.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers in tests have no capture target.
    }
    event.preventDefault();
    event.stopPropagation();
  });

  hud.addEventListener("pointermove", (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointer) return;
    const rect = hud.getBoundingClientRect();
    posX = Math.min(
      Math.max(originX + event.clientX - grabX, 0),
      Math.max(0, window.innerWidth - rect.width),
    );
    posY = Math.min(
      Math.max(originY + event.clientY - grabY, 0),
      Math.max(0, window.innerHeight - rect.height),
    );
    applyPosition(false);
    event.preventDefault();
    event.stopPropagation();
  });

  const release = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== pointer) return;
    dragging = false;
    pointer = -1;
    hud.classList.remove("dragging");
    try {
      hud.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    settle();
    event.stopPropagation();
  };
  hud.addEventListener("pointerup", release);
  hud.addEventListener("pointercancel", release);
}
