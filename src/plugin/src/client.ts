/*
 * dshoo — the in-GUI remote-access section.
 *
 * Registers one page under Settings → 远程访问 where the server address and
 * account live. Every field saves itself; the only buttons are connect and
 * disconnect. The page talks to `/remote-access/api/state`, which the host half
 * serves. React comes from the browser module table and the styling uses dsw
 * theme tokens, so the page follows the harness light and dark themes.
 */

interface ModuleLoader {
  load(registration: { id: string; factory: (require: (name: string) => unknown) => unknown }): void;
}

interface LoaderWindow {
  __ModuleLoader__?: ModuleLoader;
}

/** One settings snapshot as served by the host half. */
interface Snapshot {
  config: {
    server: string;
    username: string;
    name: string;
    enabled: boolean;
    hasPassword: boolean;
  };
  status: {
    state: "idle" | "connecting" | "connected" | "reconnecting" | "error";
    detail: string;
    instanceId: string;
    prefix: string;
    connectedAt: number;
    guiPort: number;
  };
  runtime: {
    hostname: string;
    platform: string;
    arch: string;
    dshVersion: string;
    pluginVersion: string;
  };
}

/** Draft mirrors the editable fields; the password is never echoed back. */
interface Draft {
  server: string;
  username: string;
  name: string;
  password: string;
}

const CSS = `
.dshoo { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 24px; max-width: 560px; min-width: 0; }
.dshoo, .dshoo * { box-sizing: border-box; }
.dshoo h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #e8eaf0); }
.dshoo p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #9aa3b2); }
.dshoo-card { display: flex; flex-direction: column; gap: 9px; padding: 14px 16px; min-width: 0;
  border: 0.5px solid var(--dsw-alias-border-l2, #373d49); border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1, #1b1e24); }
.dshoo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dshoo-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshoo-field > span { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #9aa3b2); }
.dshoo input { width: 100%; height: 34px; padding: 0 10px; font: inherit; font-size: 13px; min-width: 0;
  color: var(--dsw-alias-label-primary, #e8eaf0); background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2, #20242c));
  border: 0.5px solid var(--dsw-alias-border-l4, #373d49); border-radius: var(--dsw-radius-sm, 8px); outline: none; }
.dshoo input:focus { border-color: var(--dsw-alias-state-business-primary, #4d6bfe);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 18%, transparent); }
.dshoo-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dshoo button { height: 32px; padding: 0 14px; font: inherit; font-size: 13px; border-radius: var(--dsw-radius-sm, 8px);
  cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l4, #373d49);
  background: transparent; color: var(--dsw-alias-label-primary, #e8eaf0); }
.dshoo button:disabled { opacity: .55; cursor: default; }
.dshoo button.connect { color: #fff; font-weight: 500; border-color: transparent;
  background: var(--dsw-alias-state-business-primary, #4d6bfe); }
.dshoo button.disconnect { color: #fff; font-weight: 500; border-color: transparent;
  background: var(--dsw-alias-state-error-primary, #e5484d); }
.dshoo button.connect:hover, .dshoo button.disconnect:hover { filter: brightness(1.08); }
.dshoo-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 13px; min-width: 0; }
.dshoo-k { flex: none; color: var(--dsw-alias-label-secondary, #9aa3b2); }
.dshoo-v { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; word-break: break-all;
  color: var(--dsw-alias-label-primary, #e8eaf0); }
.dshoo-pill { display: inline-flex; align-items: center; gap: 6px; padding: 1px 10px; border-radius: 999px;
  font-size: 12px; border: 0.5px solid var(--dsw-alias-border-l2, #373d49);
  color: var(--dsw-alias-label-secondary, #9aa3b2); }
.dshoo-pill.on { color: var(--dsw-alias-state-success-primary, #3fb27f);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #3fb27f) 55%, transparent); }
.dshoo-pill.wait { color: var(--dsw-alias-state-warn-primary, #d9a441);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d9a441) 55%, transparent); }
.dshoo-pill.bad { color: var(--dsw-alias-state-error-primary, #ff7a7a);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff7a7a) 55%, transparent); }
.dshoo-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.dshoo-err { font-size: 12.5px; color: var(--dsw-alias-state-error-primary, #ff7a7a); }
.dshoo-note { font-size: 12px; color: var(--dsw-alias-label-tertiary, #81858c); }
@media (max-width: 560px) { .dshoo-grid { grid-template-columns: 1fr; } }
`;

const STATE_LABEL: Record<Snapshot["status"]["state"], string> = {
  idle: "未连接",
  connecting: "连接中…",
  connected: "已连接",
  reconnecting: "重连中…",
  error: "连接失败",
};

const STATE_CLASS: Record<Snapshot["status"]["state"], string> = {
  idle: "",
  connecting: "wait",
  connected: "on",
  reconnecting: "wait",
  error: "bad",
};

/** API endpoint, resolved against the document so a mounted GUI still works. */
function apiUrl(): string {
  return new URL("remote-access/api/state", document.baseURI).href;
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

((window as unknown as LoaderWindow).__ModuleLoader__)?.load({
  id: "dshoo",
  factory(require) {
    const React = require("react") as ReactLike;
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** The settings page: server address, account, and connection state. */
    function RemoteAccess(): unknown {
      const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
      const [draft, setDraft] = useState<Draft>({ server: "", username: "", name: "", password: "" });
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [saved, setSaved] = useState(false);

      /** Pending auto-save for the non-secret fields. */
      const saveTimer = useRef<number | undefined>(undefined);
      const draftRef = useRef<Draft>(draft);
      draftRef.current = draft;
      /** True while the operator has edits that are not saved yet. */
      const dirty = useRef(false);
      const passwordInput = useRef<HTMLInputElement | null>(null);

      /**
       * Adopt a host snapshot.
       *
       * The form follows the host whenever the operator is not editing it, so
       * reopening the page (or another window saving first) always shows the
       * stored configuration instead of an empty form. While an edit is
       * pending the draft wins, and the password box is never rewritten while
       * it has focus.
       */
      const applySnapshot = useCallback((next: Snapshot) => {
        setSnapshot(next);
        if (dirty.current) return;
        setDraft((current) => ({
          server: next.config.server,
          username: next.config.username,
          name: next.config.name,
          password: document.activeElement === passwordInput.current ? current.password : "",
        }));
      }, []);

      const refresh = useCallback(async () => {
        try {
          const response = await fetch(apiUrl(), { headers: { accept: "application/json" } });
          if (!response.ok) return;
          applySnapshot((await response.json()) as Snapshot);
        } catch {
          // Keep the last known state; the next poll retries.
        }
      }, [applySnapshot]);

      /**
       * Send the current draft. The password is only included when the caller
       * asks for it: a debounced save never carries a half-typed password.
       */
      const save = useCallback(async (options: { includePassword?: boolean } = {}): Promise<Snapshot | null> => {
        const includePassword = options.includePassword === true && draftRef.current.password !== "";
        const body: Record<string, unknown> = {
          server: draftRef.current.server,
          username: draftRef.current.username,
          name: draftRef.current.name,
        };
        if (includePassword) body.password = draftRef.current.password;
        try {
          const response = await fetch(apiUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const payload = (await response.json()) as Snapshot & { error?: string };
          if (!response.ok) {
            setError(payload.error ?? "保存失败");
            return null;
          }
          setError("");
          dirty.current = false;
          setSaved(true);
          window.setTimeout(() => setSaved(false), 1600);
          applySnapshot(payload);
          return payload;
        } catch (err) {
          setError((err as Error).message || "无法访问插件接口");
          return null;
        }
      }, [applySnapshot]);

      const scheduleSave = useCallback(() => {
        if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = undefined;
          void save();
        }, 700);
      }, [save]);

      const act = useCallback(async (action: "connect" | "disconnect") => {
        setBusy(true);
        setError("");
        try {
          // The action carries the whole form, so a pending debounce does not
          // need to be flushed first; it re-sends the same values without the
          // password and changes nothing.
          const body: Record<string, unknown> = {
            server: draftRef.current.server,
            username: draftRef.current.username,
            name: draftRef.current.name,
            action,
          };
          if (draftRef.current.password !== "") body.password = draftRef.current.password;
          const response = await fetch(apiUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const payload = (await response.json()) as Snapshot & { error?: string };
          if (!response.ok) {
            setError(payload.error ?? "操作失败");
            return;
          }
          dirty.current = false;
          applySnapshot(payload);
        } catch (err) {
          setError((err as Error).message || "无法访问插件接口");
        } finally {
          setBusy(false);
        }
      }, [applySnapshot]);

      useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => { void refresh(); }, 2500);
        return () => window.clearInterval(timer);
      }, [refresh]);

      const edit = (key: keyof Draft, value: string): void => {
        dirty.current = true;
        setDraft((current) => ({ ...current, [key]: value }));
        // The password is committed when the field loses focus: a debounced
        // save would otherwise persist a half-typed secret and clear the field
        // under the operator's fingers.
        if (key !== "password") scheduleSave();
      };

      if (snapshot === null) {
        return h("div", { className: "dshoo" }, h("style", null, CSS), h("p", null, "加载中…"));
      }

      const { status, config, runtime } = snapshot;
      const connected = status.state === "connected" || status.state === "connecting"
        || status.state === "reconnecting";

      const statusCard = h("div", { className: "dshoo-card" },
        h("div", { className: "dshoo-row" },
          h("span", { className: "dshoo-k" }, "状态"),
          h("span", { className: "dshoo-pill " + STATE_CLASS[status.state] },
            h("span", { className: "dshoo-dot" }),
            STATE_LABEL[status.state],
            status.state === "connected" ? ` · ${relativeTime(status.connectedAt)}` : "",
          ),
        ),
        h("div", { className: "dshoo-row" },
          h("span", { className: "dshoo-k" }, "本机"),
          h("span", { className: "dshoo-v" },
            `${runtime.hostname} · ${runtime.platform}/${runtime.arch} · dsh ${runtime.dshVersion || "未知"}`),
        ),
        status.instanceId !== ""
          ? h("div", { className: "dshoo-row" },
            h("span", { className: "dshoo-k" }, "实例 ID"),
            h("span", { className: "dshoo-v" }, status.instanceId))
          : null,
        status.state === "connected" && config.server !== ""
          ? h("div", { className: "dshoo-row" },
            h("span", { className: "dshoo-k" }, "服务端"),
            h("span", { className: "dshoo-v" }, `${config.server}/i/${status.instanceId}/`))
          : null,
        status.detail !== ""
          ? h("div", { className: "dshoo-err" }, status.detail)
          : null,
      );

      const form = h("div", { className: "dshoo-card" },
        h("div", { className: "dshoo-field" },
          h("span", null, "服务端地址"),
          h("input", {
            value: draft.server,
            placeholder: "https://fleet.example.com",
            spellCheck: false,
            autoComplete: "off",
            onChange: (event: { target: { value: string } }) => edit("server", event.target.value),
          }),
        ),
        h("div", { className: "dshoo-grid" },
          h("div", { className: "dshoo-field" },
            h("span", null, "用户名"),
            h("input", {
              value: draft.username,
              placeholder: "admin",
              spellCheck: false,
              autoComplete: "username",
              onChange: (event: { target: { value: string } }) => edit("username", event.target.value),
            }),
          ),
          h("div", { className: "dshoo-field" },
            h("span", null, "密码"),
            h("input", {
              ref: passwordInput,
              value: draft.password,
              type: "password",
              placeholder: config.hasPassword ? "已保存" : "服务器登录密码",
              autoComplete: "current-password",
              onChange: (event: { target: { value: string } }) => edit("password", event.target.value),
              onBlur: () => {
                if (draftRef.current.password !== "") void save({ includePassword: true });
              },
            }),
          ),
        ),
        h("div", { className: "dshoo-field" },
          h("span", null, "实例名称"),
          h("input", {
            value: draft.name,
            placeholder: runtime.hostname,
            spellCheck: false,
            onChange: (event: { target: { value: string } }) => edit("name", event.target.value),
          }),
        ),
        h("div", { className: "dshoo-actions" },
          connected
            ? h("button", {
              type: "button",
              className: "disconnect",
              disabled: busy,
              onClick: () => { void act("disconnect"); },
            }, busy ? "处理中…" : "断开连接")
            : h("button", {
              type: "button",
              className: "connect",
              disabled: busy,
              onClick: () => { void act("connect"); },
            }, busy ? "处理中…" : "连接"),
          saved ? h("span", { className: "dshoo-note" }, "已保存") : null,
        ),
        error !== "" ? h("div", { className: "dshoo-err" }, error) : null,
      );

      return h("div", { className: "dshoo" },
        h("style", null, CSS),
        h("h3", null, "远程访问"),
        h("p", null, "连接后可以从服务端的 Web UI 打开这台机器的 DeepSeek Harness。"),
        statusCard,
        form,
      );
    }

    return {
      inject: ["slots"],
      apply(ctx: {
        slots: {
          inject: (name: string, register: () => unknown) => void;
          register: (options: Record<string, unknown>, component: unknown) => unknown;
        };
      }) {
        ctx.slots.inject("settings.section", () => ctx.slots.register(
          { name: "settings.section", id: "dshoo", order: 65, label: "远程访问" },
          RemoteAccess,
        ));
      },
    };
  },
});

/** The slice of React the page uses, satisfied by the browser module table. */
interface ReactLike {
  createElement: (
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ) => unknown;
  useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void];
  useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]): T;
  useEffect(effect: () => void | (() => void), deps: unknown[]): void;
  useRef<T>(value: T): { current: T };
}
