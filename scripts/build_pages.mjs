// Build only the browser application. No install step or external packages.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "web");
const output = resolve(root, "site-dist");
const assets = ["index.html", "style.css", "app.js", "sample-data.js", "demo-engine.js", "favicon.svg", "_headers"];

// Refuse unrelated files instead of deleting or accidentally publishing them.
const { readdirSync } = await import("node:fs");
if (existsSync(output)) {
  if (lstatSync(output).isSymbolicLink()) throw new Error("site-dist must be a regular directory");
  const unexpected = readdirSync(output).filter(name => !assets.includes(name));
  if (unexpected.length) throw new Error("site-dist contains other files. Build from a fresh checkout or preserve those files outside site-dist first.");
}
const html = readFileSync(resolve(source, "index.html"), "utf8");
if (!html.includes('data-runtime="browser"')) throw new Error("Public entry must use browser runtime");
for (const name of assets.filter(name => name.endsWith(".js"))) {
  if (!html.includes(`src="/${name}"`)) throw new Error(`Missing script entry: ${name}`);
}
for (const name of assets) {
  if (!lstatSync(resolve(source, name)).isFile()) throw new Error(`Invalid asset: ${name}`);
}
mkdirSync(output, { recursive: true });
for (const name of assets) copyFileSync(resolve(source, name), resolve(output, name));
console.log(`Built ${assets.length} static files in site-dist/`);
