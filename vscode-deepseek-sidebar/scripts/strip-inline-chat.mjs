import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(root, "src", "chatHtml.ts");
let s = fs.readFileSync(p, "utf8");
const startMarker = "  <!-- script body: media/chatPanel.js";
const start = s.indexOf(startMarker);
if (start < 0) {
  console.error("start not found");
  process.exit(1);
}
const sub = s.slice(start);
const m = sub.match(/^[\s\S]*?\r?\n  <\/script>\r?\n(?=<\/body>)/);
if (!m) {
  console.error("block not found");
  process.exit(1);
}
s = s.slice(0, start) + s.slice(start + m[0].length);
fs.writeFileSync(p, s);
console.log("stripped ok", p);
