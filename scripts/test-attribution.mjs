// Ad-click attribution tests (src/lib/attribution.ts): parse, store, collect,
// normalize, flatten. No DOM: the browser env is injected. Same esbuild bundle
// trick as test-rate-math.mjs.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '.bundle');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'attribution-lib.mjs');
await build({
  stdin: { contents: `export * from './src/lib/attribution';`, resolveDir: join(here, '..'), loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outFile,
});
const {
  AD_PARAM_KEYS,
  parseAdParams,
  deriveLeadSource,
  normalizeAttribution,
  toLeadWebhookFields,
  captureAttribution,
  collectAttribution,
  readStoredAttribution,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
}

// A fake browser: one storage shared across "page loads".
function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
const env = (over, storage) => ({
  search: '',
  href: 'https://xcapfactoring.com/',
  referrer: '',
  now: () => new Date('2026-10-02T12:00:00Z'),
  storage,
  ...over,
});

// ---- parse
const adSearch = '?gclid=Cj0abc&utm_source=google&utm_medium=cpc&utm_campaign=xcap-contract-audit&utm_content=audit-ad1&utm_term=factoring%20contract%20audit&fbclid=ignored';
const p = parseAdParams(adSearch);
check('parse: gclid captured', p.gclid, 'Cj0abc');
check('parse: utm_term decoded', p.utm_term, 'factoring contract audit');
check('parse: unknown keys ignored', 'fbclid' in p, false);
check('parse: every allowlisted key present', Object.keys(p).length, AD_PARAM_KEYS.length);
check('parse: absent keys are empty strings', p.wbraid, '');
check('parse: long values truncated to 200', parseAdParams('?gclid=' + 'x'.repeat(400)).gclid.length, 200);

// ---- lead source
check('source: gclid -> google_ads', deriveLeadSource(p), 'google_ads');
check('source: utm google/cpc without gclid -> google_ads', deriveLeadSource(parseAdParams('?utm_source=google&utm_medium=cpc')), 'google_ads');
check('source: youtube/video', deriveLeadSource(parseAdParams('?utm_source=youtube&utm_medium=video')), 'youtube/video');
check('source: nothing -> organic', deriveLeadSource(parseAdParams('')), 'organic');

// ---- capture across page loads: ad landing on home, then click to /audit
const storage = fakeStorage();
const landed = captureAttribution(env({ search: adSearch, href: 'https://xcapfactoring.com/' + adSearch, referrer: 'https://www.google.com/' }, storage));
check('capture: ad landing stores the click', landed.params.gclid, 'Cj0abc');
check('capture: landing page kept', landed.landingPage, 'https://xcapfactoring.com/' + adSearch);
const audited = captureAttribution(env({ href: 'https://xcapfactoring.com/audit' }, storage));
check('capture: /audit without params keeps the stored click', audited.params.gclid, 'Cj0abc');
check('capture: landing page still the ad landing', audited.landingPage, 'https://xcapfactoring.com/' + adSearch);
const collected = collectAttribution(env({ href: 'https://xcapfactoring.com/audit' }, storage));
check('collect: submit on /audit carries the click', collected.params.utm_campaign, 'xcap-contract-audit');

// A newer click replaces the older one.
captureAttribution(env({ search: '?gclid=NEWER', href: 'https://xcapfactoring.com/audit?gclid=NEWER' }, storage));
check('capture: newer click wins', collectAttribution(env({}, storage)).params.gclid, 'NEWER');

// ---- organic: first page seen is kept, params empty
const org = fakeStorage();
captureAttribution(env({ href: 'https://xcapfactoring.com/privacy', referrer: 'https://duckduckgo.com/' }, org));
captureAttribution(env({ href: 'https://xcapfactoring.com/audit' }, org));
const orgCollected = collectAttribution(env({ href: 'https://xcapfactoring.com/audit' }, org));
check('organic: first page kept as landing', orgCollected.landingPage, 'https://xcapfactoring.com/privacy');
check('organic: referrer kept', orgCollected.referrer, 'https://duckduckgo.com/');
check('organic: lead_source organic', toLeadWebhookFields(orgCollected).lead_source, 'organic');

// ---- expiry: a 91-day-old record is ignored
const old = fakeStorage();
captureAttribution(env({ search: '?gclid=OLD', now: () => new Date('2026-06-01T00:00:00Z') }, old));
check('expiry: 90+ day old click dropped', readStoredAttribution(env({}, old)), null);

// ---- no storage (private mode): current URL still works at submit
const noStore = collectAttribution(env({ search: '?gclid=NOSTORE', href: 'https://xcapfactoring.com/audit?gclid=NOSTORE' }, null));
check('no storage: current URL params used', noStore.params.gclid, 'NOSTORE');
check('no storage: capture returns a record without throwing', captureAttribution(env({ search: '?gclid=x' }, null)).params.gclid, 'x');

// ---- server normalize: unknown keys dropped, bounds enforced, shape complete
const norm = normalizeAttribution({ params: { gclid: ' abc ', evil: 'x', utm_term: 'y'.repeat(300) }, landingPage: 'https://x', junk: 1 });
check('normalize: trims', norm.params.gclid, 'abc');
check('normalize: drops unknown params', 'evil' in norm.params, false);
check('normalize: truncates', norm.params.utm_term.length, 200);
check('normalize: fills missing fields', [norm.referrer, norm.firstSeenAt], ['', '']);
check('normalize: undefined -> complete empty record', normalizeAttribution(undefined).params.gclid, '');

// ---- flat webhook fields: every key present, always
const flat = toLeadWebhookFields(undefined);
const EXPECTED_KEYS = [
  'lead_source', 'gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'campaign_id', 'adgroup_id', 'keyword', 'matchtype', 'device', 'network', 'landing_page', 'referrer', 'first_seen_at',
];
check('flat: exact key set', Object.keys(flat), EXPECTED_KEYS);
check('flat: organic defaults', [flat.lead_source, flat.gclid, flat.utm_campaign], ['organic', '', '']);
const flatAd = toLeadWebhookFields(collected);
check('flat: ad click maps through', [flatAd.lead_source, flatAd.gclid, flatAd.utm_content], ['google_ads', 'Cj0abc', 'audit-ad1']);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
