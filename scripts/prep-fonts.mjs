// Copies the self-hosted woff2 subsets out of the @fontsource packages into public/fonts.
// Design spec: Archivo (variable, wdth axis for SemiExpanded), Public Sans 400/500,
// Spline Sans Mono 400/600. All served same-origin, font-display: optional (perf doctrine).
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'public', 'fonts');
mkdirSync(out, { recursive: true });

const wanted = [
  // Prefer the full-axes Archivo variable file (wght + wdth); fall back to wght-only.
  {
    pkg: '@fontsource-variable/archivo',
    candidates: ['archivo-latin-full-normal.woff2', 'archivo-latin-wght-normal.woff2'],
    dest: 'archivo-var.woff2',
  },
  { pkg: '@fontsource/public-sans', candidates: ['public-sans-latin-400-normal.woff2'], dest: 'public-sans-400.woff2' },
  { pkg: '@fontsource/public-sans', candidates: ['public-sans-latin-500-normal.woff2'], dest: 'public-sans-500.woff2' },
  { pkg: '@fontsource/spline-sans-mono', candidates: ['spline-sans-mono-latin-400-normal.woff2'], dest: 'spline-mono-400.woff2' },
  { pkg: '@fontsource/spline-sans-mono', candidates: ['spline-sans-mono-latin-600-normal.woff2'], dest: 'spline-mono-600.woff2' },
];

let failed = false;
for (const w of wanted) {
  const dir = path.join(root, 'node_modules', w.pkg, 'files');
  const found = w.candidates.find((c) => existsSync(path.join(dir, c)));
  if (!found) {
    failed = true;
    console.error(`MISSING: none of ${w.candidates.join(', ')} in ${dir}`);
    if (existsSync(dir)) console.error('  available:', readdirSync(dir).filter((f) => f.includes('latin') && f.endsWith('.woff2')).slice(0, 10).join(', '));
    continue;
  }
  copyFileSync(path.join(dir, found), path.join(out, w.dest));
  console.log(`copied ${w.pkg}/files/${found} -> public/fonts/${w.dest}`);
}
process.exit(failed ? 1 : 0);
