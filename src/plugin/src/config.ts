import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Local plugin configuration.
 *
 * Stored beside the rest of the harness state so it travels with the profile
 * and stays outside the project working tree. The password is only ever read by
 * this process; the settings API returns a boolean saying whether one is stored.
 */
export interface PluginConfig {
  /** Server base URL, for example "https://fleet.example.com". */
  server: string;
  username: string;
  password: string;
  /** Stable identity of this installation; survives reconnects and restarts. */
  instanceKey: string;
  /** Display name shown in the server's instance list. */
  name: string;
  /**
   * Whether the tunnel should be up. Set by the connect and disconnect
   * buttons, so a manual disconnect also survives a restart.
   */
  enabled: boolean;
}

const DEFAULTS: PluginConfig = {
  server: "",
  username: "",
  password: "",
  instanceKey: "",
  name: "",
  enabled: false,
};

/** dsh home directory, matching where the harness keeps its own state. */
function dshHome(): string {
  const explicit = process.env.DSH_HOME?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".dsh");
}

/** Absolute path of the plugin's configuration file. */
export function configPath(): string {
  return join(dshHome(), "dshoo.json");
}

/** Read the stored configuration, filling defaults for missing keys. */
export function readConfig(): PluginConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PluginConfig>;
    return normalize(parsed);
  } catch {
    // A missing or unreadable file is a fresh install, not an error.
    return { ...DEFAULTS };
  }
}

/** Merge a patch into the stored configuration and return the result. */
export function writeConfig(patch: Partial<PluginConfig>): PluginConfig {
  const current = readConfig();
  const next = normalize({ ...current, ...patch });
  if (next.instanceKey === "") {
    next.instanceKey = randomBytes(12).toString("base64url");
  }
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file is already user-scoped.
  }
  return next;
}

/** Ensure the configuration has an identity before the first connection. */
export function ensureIdentity(): PluginConfig {
  const config = readConfig();
  if (config.instanceKey !== "") return config;
  return writeConfig({});
}

/** Coerce an arbitrary value into a complete, trimmed configuration. */
function normalize(input: Partial<PluginConfig>): PluginConfig {
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  return {
    server: normalizeServer(text(input.server)),
    username: text(input.username),
    password: typeof input.password === "string" ? input.password : "",
    instanceKey: text(input.instanceKey),
    name: text(input.name),
    enabled: input.enabled === true,
  };
}

/**
 * Turn what a user types into a base URL: a bare host gets https, and the
 * trailing slash is dropped so paths append predictably.
 */
export function normalizeServer(raw: string): string {
  if (raw === "") return "";
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, "");
  try {
    const url = new URL(value);
    // A websocket scheme is accepted from people copying it out of docs.
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    url.search = "";
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Derive the tunnel WebSocket URL from the configured server base. */
export function tunnelUrl(server: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/tunnel`;
  return url.toString();
}
