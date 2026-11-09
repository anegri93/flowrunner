// Pasa scripts/nave.svg a orca/assets/nave.webp, un WebP animado: el `Image` de Orca solo
// muestra png, jpg o webp. Chromium congela cada cuadro de la animación y lo codifica como WebP;
// acá solo se juntan esos cuadros en un contenedor animado (RIFF: VP8X, ANIM y un ANMF por cuadro).
//
// flowrunner no depende de Playwright: se usa el de otro proyecto, y su Chromium.
//   PLAYWRIGHT_FROM=<carpeta con node_modules/@playwright/test> node scripts/nave-webp.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const from = process.env.PLAYWRIGHT_FROM;
if (from === undefined) throw new Error("Falta PLAYWRIGHT_FROM: ver el comentario de arriba.");
const { chromium } = createRequire(join(from, "package.json"))("@playwright/test");

const SIZE = 240; // el doble de los 120 del dibujo, para pantallas retina
const CICLO_MS = 2400; // el ciclo común de todas las animaciones del SVG
const CUADROS = 48;
const CUADRO_MS = CICLO_MS / CUADROS;
const assets = new URL("../orca/assets/", import.meta.url);

const svg = readFileSync(new URL("nave.svg", import.meta.url), "utf8").replace(
  /width="120" height="120"/,
  `width="${SIZE}" height="${SIZE}"`,
);

const browser = await chromium.launch();
const frames = [];
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  for (let i = 0; i < CUADROS; i++) {
    await page.evaluate((t) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = t;
      }
    }, i * CUADRO_MS);
    const png = await page.screenshot({ omitBackground: true });
    const webp = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      return canvas.toDataURL("image/webp", 0.9).split(",")[1];
    }, png.toString("base64"));
    frames.push(Buffer.from(webp, "base64"));
  }
} finally {
  await browser.close();
}

/** Lo que va dentro de un ANMF: solo ALPH + VP8, o VP8L. Chromium además mete VP8X e ICCP. */
const FRAME_CHUNKS = new Set(["ALPH", "VP8 ", "VP8L"]);
function frameData(webp) {
  if (webp.toString("ascii", 0, 4) !== "RIFF" || webp.toString("ascii", 8, 12) !== "WEBP")
    throw new Error("Chromium no devolvió un WebP");
  const out = [];
  for (let at = 12; at < webp.length;) {
    const size = webp.readUInt32LE(at + 4);
    const end = at + 8 + size + (size % 2);
    if (FRAME_CHUNKS.has(webp.toString("ascii", at, at + 4))) out.push(webp.subarray(at, end));
    at = end;
  }
  return Buffer.concat(out);
}

const u24 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
function chunk(tag, body) {
  const head = Buffer.alloc(8);
  head.write(tag, 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
}

const vp8x = chunk(
  "VP8X",
  Buffer.concat([Buffer.from([0x12, 0, 0, 0]), u24(SIZE - 1), u24(SIZE - 1)]), // alfa + animación
);
const anim = chunk("ANIM", Buffer.from([0, 0, 0, 0, 0, 0])); // fondo transparente, loop infinito
const anmf = frames.map((f) =>
  chunk(
    "ANMF",
    Buffer.concat([
      u24(0),
      u24(0),
      u24(SIZE - 1),
      u24(SIZE - 1),
      u24(CUADRO_MS),
      Buffer.from([0x02]), // cada cuadro reemplaza al anterior, sin mezclar
      frameData(f),
    ]),
  ),
);
const body = Buffer.concat([Buffer.from("WEBP", "ascii"), vp8x, anim, ...anmf]);
const riff = Buffer.alloc(8);
riff.write("RIFF", 0, "ascii");
riff.writeUInt32LE(body.length, 4);
writeFileSync(new URL("nave.webp", assets), Buffer.concat([riff, body]));
console.log(`nave.webp: ${String(CUADROS)} cuadros, ${String(body.length + 8)} bytes`);
