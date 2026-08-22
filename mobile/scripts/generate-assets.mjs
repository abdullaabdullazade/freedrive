// Generates all mobile app image assets from the FreeDrive logo
// (same artwork as desktop/public/logo.svg). Run: node scripts/generate-assets.mjs
import { Resvg } from "@resvg/resvg-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "..", "assets");

// Inner paths of desktop/public/logo.svg (viewBox 0 0 87.3 78)
const LOGO_W = 87.3;
const LOGO_H = 78;
const logoInner = `
  <path d="M6.6 66.85L3.3 61.35 29.1 17 35.7 17 10 61.35z" fill="#0066DA"/>
  <path d="M43.65 25L29.1 0 58.2 0 72.8 25z" fill="#00AC47"/>
  <path d="M72.8 25L87.3 50 58.2 78 43.7 53z" fill="#EA4335"/>
  <path d="M43.65 25L29.1 50 0 50 14.5 25z" fill="#2684FC"/>
  <path d="M43.65 25L58.2 50 29.1 50z" fill="#00832D"/>
  <path d="M72.8 25L87.3 50 58.2 50z" fill="#FFBA00"/>
`;
const logoMono = logoInner.replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#FFFFFF"');

function frame({ size, logoScale, bg, mono = false }) {
  const scale = (size * logoScale) / LOGO_W;
  const w = LOGO_W * scale;
  const h = LOGO_H * scale;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
    ${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ""}
    <g transform="translate(${x} ${y}) scale(${scale})">${mono ? logoMono : logoInner}</g>
  </svg>`;
}

function render(svg, size, file) {
  const resvg = new Resvg(Buffer.from(svg), {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  });
  const png = resvg.render().asPng();
  fs.writeFileSync(path.join(assetsDir, file), png);
  console.log(`wrote assets/${file} (${size}x${size})`);
}

// Main app icon: logo on dark background
render(frame({ size: 1024, logoScale: 0.62, bg: "#121212" }), 1024, "icon.png");

// Android adaptive icon: foreground within the ~66% safe zone, solid background
render(frame({ size: 512, logoScale: 0.5 }), 512, "android-icon-foreground.png");
render(frame({ size: 512, logoScale: 0, bg: "#121212" }), 512, "android-icon-background.png");
render(frame({ size: 432, logoScale: 0.5, mono: true }), 432, "android-icon-monochrome.png");

// Splash: logo on transparent background (backgroundColor set in app.json)
render(frame({ size: 1024, logoScale: 0.42 }), 1024, "splash-icon.png");

// Web favicon
render(frame({ size: 48, logoScale: 0.92 }), 48, "favicon.png");
