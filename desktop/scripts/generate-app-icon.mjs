import { Resvg } from "@resvg/resvg-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const inner = fs
  .readFileSync(path.join(root, "public/logo.svg"), "utf8")
  .replace(/<svg[^>]*>/, "")
  .replace(/<\/svg>/, "");

const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88"><g transform="translate(0.35 5)">${inner}</g></svg>`;

const resvg = new Resvg(Buffer.from(square), {
  fitTo: { mode: "width", value: 1024 },
  background: "rgba(0,0,0,0)",
});

const rendered = resvg.render();
const png = rendered.asPng();
fs.writeFileSync(path.join(root, "app-icon.png"), png);
console.log(`wrote app-icon.png ${rendered.width}x${rendered.height}`);
