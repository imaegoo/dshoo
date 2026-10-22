// The harness evaluates a plugin's client bundle as a classic script, so a
// trailing `export {};` (which TypeScript adds to every module in a
// `"type": "module"` package) is a syntax error in the browser. The host half
// keeps its module syntax; only the browser half is rewritten.
import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("../lib/client.js", import.meta.url);
const source = readFileSync(target, "utf8");
const stripped = source
  .replace(/^export \{\};\s*$/gmu, "")
  .replace(/^import .*?;\s*$/gmu, "")
  .replace(/^export (?:default |const |function |class |async )/gmu, "/* non-module bundle: $& */ ");

if (/^\s*(?:import|export)\s/mu.test(stripped)) {
  console.error("postbuild: lib/client.js still contains module syntax");
  process.exit(1);
}
writeFileSync(target, stripped, "utf8");
console.log("postbuild: lib/client.js is a classic-script bundle");
