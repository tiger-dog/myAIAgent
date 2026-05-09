import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatHtml = path.join(__dirname, "..", "src", "chatHtml.ts");
const outDir = path.join(__dirname, "..", "media");
const outFile = path.join(outDir, "chatPanel.js");

const s = fs.readFileSync(chatHtml, "utf8");
const start = '<script nonce="${cspNonce}">';
const a = s.indexOf(start);
const b = s.indexOf("  </script>", a);
if (a < 0 || b < 0) {
  console.error("markers", a, b);
  process.exit(1);
}
const inner = s.slice(a + start.length, b);
const lines = inner.split(/\r?\n/);
const out = lines.map((l) => (/^    /.test(l) ? l.slice(4) : l)).join("\n");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, out.trim() + "\n");
console.log("wrote", outFile, out.length);
