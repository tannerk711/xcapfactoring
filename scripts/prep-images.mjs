// Compress the fal-generated raws into AVIF/WebP (+jpg fallback), emit LQIP placeholders,
// lighten the ledger texture toward the paper token, and compose the OG image.
// Usage: node scripts/prep-images.mjs
import sharp from 'sharp';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const raw = (n) => path.join(root, 'tmp', 'img-raw', n);
const outDir = path.join(root, 'public', 'img');
const dataDir = path.join(root, 'src', 'data');
mkdirSync(outDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const manifest = {};

async function emit(name, input, { width, avifQ = 55, webpQ = 74, jpgQ = 78, lqip = false, pre = (s) => s }) {
  const base = pre(sharp(input).resize({ width, withoutEnlargement: true }));
  const avif = path.join(outDir, `${name}.avif`);
  const webp = path.join(outDir, `${name}.webp`);
  const jpg = path.join(outDir, `${name}.jpg`);
  await base.clone().avif({ quality: avifQ }).toFile(avif);
  await base.clone().webp({ quality: webpQ }).toFile(webp);
  await base.clone().flatten({ background: '#FAF7F2' }).jpeg({ quality: jpgQ, mozjpeg: true }).toFile(jpg);
  const meta = await sharp(webp).metadata();
  const entry = { width: meta.width, height: meta.height };
  if (lqip) {
    const buf = await pre(sharp(input)).resize({ width: 28 }).blur(1.2).webp({ quality: 32 }).toBuffer();
    entry.lqip = `data:image/webp;base64,${buf.toString('base64')}`;
  }
  manifest[name] = entry;
  console.log(`emitted ${name} @${meta.width}x${meta.height}`);
}

const warmPaper = (s) => s.modulate({ saturation: 0.92 });

// Hero: desktop-only element, so one 1600w set + LQIP for the mobile gradient wash.
await emit('hero-desk', raw('hero-desk-v3.png'), { width: 1600, lqip: true });

// Ledger texture: used at low opacity; push it toward the paper token (lighten + desat).
await emit('texture-ledger', raw('texture-ledger.png'), {
  width: 900,
  avifQ: 45,
  webpQ: 60,
  pre: (s) => s.modulate({ saturation: 0.35, brightness: 1.13 }),
});

// Industry cards render ~560px wide; 980w covers retina.
// industry-government added 2026-08-18 (replaces construction in the homepage grid);
// industry-construction stays emitted for the future /industries/construction page.
for (const n of ['industry-trucking', 'industry-staffing', 'industry-government', 'industry-manufacturing', 'industry-construction']) {
  await emit(n, raw(`${n}.png`), { width: 980, lqip: true, pre: warmPaper });
}

// Editorial pattern interrupt.
if (existsSync(raw('editorial-trap.png'))) {
  await emit('editorial-trap', raw('editorial-trap.png'), { width: 1100, lqip: true });
}

// OG image: hero crop + navy scrim + real text composed at build (never generated text).
{
  const W = 1200, H = 630;
  const heroBuf = await sharp(raw('hero-desk-v3.png'))
    .resize(W, H, { fit: 'cover', position: 'attention' })
    .modulate({ brightness: 0.94 })
    .toBuffer();
  const overlay = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#0E1B33" opacity="0.62"/>
    <rect x="60" y="${H - 210}" width="112" height="9" fill="#FFD34D"/>
    <text x="60" y="150" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="700" fill="#FAF7F2">XCAP <tspan fill="#7BC9A3">FACTORING</tspan></text>
    <text x="60" y="${H - 250}" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="700" fill="#FFFFFF">What does your factoring</text>
    <text x="60" y="${H - 165}" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="700" fill="#FFFFFF">contract really cost?</text>
    <text x="60" y="${H - 90}" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#E3DED4">Free contract audit. Your true effective rate in about a minute.</text>
  </svg>`);
  await sharp(heroBuf).composite([{ input: overlay }]).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(outDir, 'og-image.jpg'));
  console.log('emitted og-image.jpg');
}

writeFileSync(path.join(dataDir, 'images.json'), JSON.stringify(manifest, null, 2));
console.log('wrote src/data/images.json');
