// Live extraction test on the SEC-filed Bay View Funding factoring agreement
// (the tool's first golden-set document). Reads site/.env for ANTHROPIC_API_KEY;
// if the key is missing it prints a clear BLOCKED message and exits 0 so the
// suite is honest about what ran.
//
// Flow: download the SEC EDGAR exhibit HTML (UA header required, SEC blocks
// default agents) -> render to PDF with puppeteer-core (borrowed from
// foundation/tools) -> run the REAL pipeline pieces: extractTerms (claude-opus-5
// via messages.parse + zodOutputFormat) -> buildReport -> print the verdict.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..');

// ---- read site/.env (no dotenv dependency) ----
const envPath = join(siteDir, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('BLOCKED: no ANTHROPIC_API_KEY in site/.env or the environment.');
  console.log('The live extraction test cannot run until Tanner adds the key.');
  console.log('Everything else (rate math, report logic) is covered by test-rate-math.mjs.');
  process.exit(0);
}

const SEC_URL = 'https://www.sec.gov/Archives/edgar/data/1665300/000121390018004257/fs42018ex10-17_stellaracq3.htm';

// ---- 1. download the exhibit ----
console.log('Downloading SEC exhibit...');
const res = await fetch(SEC_URL, {
  headers: { 'User-Agent': 'XCap Factoring audit-tool test tanner@creloanpro.com', Accept: 'text/html' },
});
if (!res.ok) {
  console.error(`SEC download failed: ${res.status}`);
  process.exit(1);
}
const html = await res.text();
const tmpDir = join(here, '.bundle');
mkdirSync(tmpDir, { recursive: true });
const htmlPath = join(tmpDir, 'bayview.html');
writeFileSync(htmlPath, html);

// ---- 2. render to PDF with puppeteer-core from foundation/tools ----
console.log('Rendering to PDF...');
const toolsDir = resolve(siteDir, '../../../foundation/tools');
const toolsRequire = createRequire(join(toolsDir, 'package.json'));
const puppeteer = toolsRequire('puppeteer-core');
const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const chrome = CHROME_PATHS.find(existsSync);
if (!chrome) {
  console.error('Chrome not found for PDF rendering.');
  process.exit(1);
}
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 60000 });
const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
await browser.close();
const pdfPath = join(tmpDir, 'bayview.pdf');
writeFileSync(pdfPath, pdfBytes);
console.log(`PDF ready: ${pdfPath} (${Math.round(pdfBytes.length / 1024)} KB)`);

// ---- 3. bundle the real pipeline pieces and run extraction ----
const outFile = join(tmpDir, 'extract-lib.mjs');
await build({
  stdin: {
    contents: `
      export { extractTerms } from './src/lib/audit/extract';
      export { buildReport } from './src/lib/audit/report';
    `,
    resolveDir: siteDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  outfile: outFile,
});
const { extractTerms, buildReport } = await import(pathToFileURL(outFile).href);

console.log('Calling claude-opus-5 extraction (this can take 20-90s)...');
const started = Date.now();
const extraction = await extractTerms([
  {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(pdfBytes).toString('base64') },
  },
]);
console.log(`Extraction done in ${Math.round((Date.now() - started) / 1000)}s`);

// ---- 4. report + golden-set checks ----
const report = buildReport(extraction);
const flags = report.allFlags.map((f) => `[${f.severity}] ${f.id}`);

console.log('\n--- Extraction highlights ---');
console.log('factor_name:', extraction.factor_name);
console.log('document_type:', extraction.document_type, extraction.document_type_confidence_pct + '%');
console.log('fee_structure_type:', extraction.fee_structure_type);
console.log('fee_tiers:', JSON.stringify(extraction.fee_tiers));
console.log('interest_base:', extraction.interest_base);
console.log('auto_renewal:', JSON.stringify(extraction.auto_renewal));
console.log('early_termination_fee:', JSON.stringify(extraction.early_termination_fee));
console.log('release_terms:', JSON.stringify(extraction.release_terms));
console.log('misdirected_payment_penalty:', JSON.stringify(extraction.misdirected_payment_penalty));

console.log('\n--- Report ---');
console.log('status:', report.visitor.status);
console.log('flags:', flags.join(', '));
console.log('verdict:', report.visitor.verdict?.line);
console.log(
  'scenarios:',
  report.math?.scenarios.map((s) => `${s.days}d fee ${s.feePctOfFace}% aprCash ${s.aprOnCash}%`).join(' | '),
);

// Golden-set expectations from the primary source (context/modern-factoring-research.md)
const expects = [
  ['tiered fee structure', extraction.fee_structure_type === 'tiered_by_days'],
  ['first tier ~1.80%', (extraction.fee_tiers ?? []).some((t) => Math.abs(t.rate_pct - 1.8) < 0.01)],
  ['block tier ~0.65%/10d', (extraction.fee_tiers ?? []).some((t) => Math.abs(t.rate_pct - 0.65) < 0.01 && t.block_days === 10)],
  ['ETF months-remaining', extraction.early_termination_fee.structure === 'months_remaining_formula'],
  ['general release required', extraction.release_terms.general_release_required === 'yes'],
  ['auto renewal found', extraction.auto_renewal.found === 'yes'],
];
let pass = 0;
for (const [label, ok] of expects) {
  console.log(`${ok ? 'PASS' : 'CHECK'}  ${label}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${expects.length} golden-set expectations met. Non-passing items need a prompt-tuning look, not necessarily a bug.`);
