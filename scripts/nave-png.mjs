// Pasa scripts/nave.svg a orca/assets/nave.png, la nave que muestra el panel de Orca mientras lee
// los runs. El `Image` de Orca solo muestra png, jpg o webp, y nunca animados.
//
// flowrunner no depende de Playwright: se usa el de otro proyecto, y su Chromium.
//   PLAYWRIGHT_FROM=<carpeta con node_modules/@playwright/test> node scripts/nave-png.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const from = process.env.PLAYWRIGHT_FROM;
if (from === undefined) throw new Error("Falta PLAYWRIGHT_FROM: ver el comentario de arriba.");
const { chromium } = createRequire(join(from, "package.json"))("@playwright/test");

const SIZE = 240; // el doble de los 120 del dibujo, para pantallas retina
const svg = readFileSync(new URL("nave.svg", import.meta.url), "utf8").replace(
  /width="120" height="120"/,
  `width="${SIZE}" height="${SIZE}"`,
);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const path = new URL("../orca/assets/nave.png", import.meta.url).pathname;
  await page.screenshot({ path, omitBackground: true });
  console.log(path);
} finally {
  await browser.close();
}
