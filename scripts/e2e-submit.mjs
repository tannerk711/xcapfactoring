// Real end-to-end submit against a deployed environment: client-direct blob
// upload -> POST /api/audit -> poll status -> print the visitor report.
// Fires the REAL Zapier webhooks (that is the point: Zapier needs sample
// payloads and the flow needs proving). Usage:
//   node scripts/e2e-submit.mjs [baseUrl]
// Default baseUrl: https://xcapfactoring.vercel.app
// The test contract is the SEC-filed Bay View specimen; run test-extraction
// once first if scripts/.bundle/bayview.pdf does not exist yet.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upload } from '@vercel/blob/client';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] ?? 'https://xcapfactoring.vercel.app').replace(/\/$/, '');
const pdfPath = join(here, '.bundle', 'bayview.pdf');
if (!existsSync(pdfPath)) {
  console.error('Missing scripts/.bundle/bayview.pdf. Run `npm run test:extraction` once to fetch/render it.');
  process.exit(1);
}

const CONSENT_TEXT =
  'I agree that XCap Factoring may contact me about my audit by phone, text message, and email, including automated messages, at the number and email I provided. Consent is not a condition of any purchase. Message and data rates may apply.';

// ---- 1. client-direct blob upload (same flow as the browser island) ----
console.log(`Uploading Bay View specimen to ${BASE} ...`);
const bytes = readFileSync(pdfPath);
const file = new File([bytes], 'bayview-test.pdf', { type: 'application/pdf' });
const batch = Date.now().toString(36);
const result = await upload(`contracts/${batch}/bayview-test.pdf`, file, {
  access: 'public',
  handleUploadUrl: `${BASE}/api/audit/upload`,
  contentType: 'application/pdf',
});
console.log('Blob uploaded:', result.pathname);

// ---- 2. submit ----
const submitRes = await fetch(`${BASE}/api/audit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'E2E Test Lead (Tanner)',
    email: 'tanner@creloanpro.com',
    phone: '5555550100',
    company: '',
    files: [{ url: result.url, pathname: result.pathname, contentType: 'application/pdf' }],
    consent: {
      agreed: true,
      text: CONSENT_TEXT,
      clientTimestamp: new Date().toISOString(),
      url: `${BASE}/audit`,
    },
  }),
});
const submitBody = await submitRes.json();
if (!submitRes.ok) {
  console.error('SUBMIT FAILED', submitRes.status, submitBody);
  process.exit(1);
}
const { jobId } = submitBody;
console.log('Submitted. jobId:', jobId);
console.log('(Lead webhook should have fired to Zapier now.)');

// ---- 3. poll ----
const started = Date.now();
let last = '';
while (Date.now() - started < 6 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 3000));
  const res = await fetch(`${BASE}/api/audit/status?jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
  if (!res.ok) {
    console.error('status check failed', res.status);
    continue;
  }
  const status = await res.json();
  const line = JSON.stringify({ done: status.done, stage: status.stage ?? null });
  if (line !== last) {
    console.log(`${Math.round((Date.now() - started) / 1000)}s`, line);
    last = line;
  }
  if (status.done) {
    console.log('\n--- Visitor report ---');
    console.log(JSON.stringify(status.report, null, 2).slice(0, 3000));
    console.log(`\nResults page: ${BASE}/audit/results/${jobId}`);
    const ok = status.report?.status === 'ok';
    process.exit(ok ? 0 : 2);
  }
}
console.error('TIMED OUT after 6 minutes');
process.exit(1);
