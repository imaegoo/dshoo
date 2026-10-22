import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Access to the harness this plugin runs inside.
 *
 * The plugin proxies this process's own web GUI, which listens on loopback and
 * authenticates every browser with a signed cookie bound to the request
 * authority. The harness can mint a one-time login URL for its own process, so
 * the plugin exchanges that token for a cookie instead of reimplementing the
 * signature.
 */

/** The subset of the Cordis context the plugin reads. */
export interface HarnessContext {
  webServer?: { port?: number };
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; debug?: (message: string) => void };
  get?: (name: string) => unknown;
  effect?: (fn: () => unknown, label?: string) => void;
}

interface ConnectionService {
  authenticatedUrl?: (baseUrl: string) => string;
}

/** Reads the harness version without assuming where the plugin is installed. */
export function harnessVersion(): string {
  const packages = ["@deepseek-ai/dsh", "@deepseek-ai/dsh-desktop-runtime", "@deepseek-ai/dsh-desktop-host"];
  // The plugin lives in a profile directory, so resolve from this module, the
  // process entry point, and the working directory in turn.
  const bases: string[] = [import.meta.url];
  const entry = process.argv[1];
  if (typeof entry === "string" && entry !== "") {
    try {
      bases.push(pathToFileURL(entry).href);
    } catch {
      // A non-path argv entry simply contributes no resolution base.
    }
  }
  bases.push(pathToFileURL(join(process.cwd(), "index.js")).href);
  for (const base of bases) {
    let require: NodeRequire;
    try {
      require = createRequire(base);
    } catch {
      continue;
    }
    for (const name of packages) {
      try {
        const pkg = require(`${name}/package.json`) as { version?: string };
        if (typeof pkg.version === "string") return pkg.version;
      } catch {
        // Try the next package or base.
      }
    }
  }
  return "";
}

/** Local origin and browser cookie for this harness process. */
export class LocalHarness {
  private cookie?: string;
  private pending?: Promise<string>;

  constructor(
    private readonly ctx: HarnessContext,
    private readonly log: (message: string) => void,
  ) {}

  /** Listening port of the harness web server, if it has bound one. */
  port(): number | undefined {
    const port = this.ctx.webServer?.port;
    return typeof port === "number" && port > 0 ? port : undefined;
  }

  /** Authority the harness's own cookies are scoped to. */
  authority(): string {
    return `127.0.0.1:${String(this.port())}`;
  }

  /** Origin used for the upstream requests the plugin makes. */
  origin(): string {
    return `http://${this.authority()}`;
  }

  /** Drop a cached cookie, for example after an authentication failure. */
  invalidate(): void {
    this.cookie = undefined;
    this.pending = undefined;
  }

  /** Resolve a browser-session cookie for the local harness. */
  async sessionCookie(force = false): Promise<string> {
    if (!force && this.cookie !== undefined) return this.cookie;
    if (this.pending !== undefined) return this.pending;
    this.pending = this.acquire().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async acquire(): Promise<string> {
    const origin = this.origin();
    const connection = this.ctx.get?.("connection") as ConnectionService | undefined;
    let loginUrl: string | undefined;
    if (typeof connection?.authenticatedUrl === "function") {
      loginUrl = connection.authenticatedUrl(`${origin}/`);
    } else {
      loginUrl = launchUrlFromEnvironment();
    }
    if (loginUrl === undefined) {
      throw new Error("无法取得本机 dsh 的登录凭据（connection 服务不可用）");
    }
    const response = await fetch(loginUrl, {
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    const cookies = readSetCookie(response.headers);
    const session = cookies.find((value) => value.startsWith("dsh-auth-"));
    if (session === undefined) {
      throw new Error(`本机 dsh 未返回会话 cookie（HTTP ${response.status}）`);
    }
    this.cookie = session;
    this.log(`acquired local session cookie (HTTP ${response.status})`);
    return session;
  }
}

/** Read every Set-Cookie value, tolerating runtimes without getSetCookie(). */
function readSetCookie(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof withGetter.getSetCookie === "function"
    ? withGetter.getSetCookie()
    : splitCombinedCookie(headers.get("set-cookie") ?? "");
  return raw.map((value) => value.split(";")[0]?.trim() ?? "").filter(Boolean);
}

/** Split a folded Set-Cookie header on the cookie boundaries. */
function splitCombinedCookie(value: string): string[] {
  if (value === "") return [];
  return value.split(/,(?=\s*[^;=]+=[^;]+)/u);
}

/** Last-resort launch token discovery for harnesses without the connection API. */
function launchUrlFromEnvironment(): string | undefined {
  const candidates = [process.env.DSH_WEB_URL, ...process.argv];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = /(https?:\/\/[^\s"']+\?[^\s"']*\btoken=[^\s"'&]+)/u.exec(candidate);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}
