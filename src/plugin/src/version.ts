import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version of the installed package.
 *
 * Read from the package manifest next to the built output instead of being
 * hard-coded: the release pipeline rewrites the version, and the server shows
 * it in the instance list to make mismatched installs visible.
 */
export const pluginVersion: string = (() => {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
