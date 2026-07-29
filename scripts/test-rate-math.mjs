// Deterministic rate-math tests against published APR anchors + the SEC-filed
// Bay View specimen. The lib is TypeScript with extensionless imports, so we
// bundle it with esbuild (ships with vite) and import the bundle.
//
// Anchors (sourced in context/modern-factoring-research.md):
//   Corpay worked example: 2.5% fee, 85% advance, 30 days -> ~30% APR on face,
//     ~35-36% on cash received.
//   fundingcompass-style: 2% at 30 days -> ~24% APR on face.
//   Bay View (SEC EDGAR): 1.80% first 30 days + 0.65% per 10 days after;
//     day 35 bills 2.45% = ~25.5%/yr on face. ETF months-remaining formula,
//     general release required.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '.bundle');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'audit-lib.mjs');

await build({
  stdin: {
    contents: `
      export * from './src/lib/audit/schema';
      export * from './src/lib/audit/rate-math';
      export * from './src/lib/audit/report';
    `,
    resolveDir: join(here, '..'),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outFile,
});

const lib = await import(pathToFileURL(outFile).href);
const { ExtractionSchema, runRateMath, feePctForDays, buildReport } = lib;

// ---- fixture builder: every field present, "nothing found" defaults ----
const baseExtraction = () => ({
  advance_rate_pct: null,
  fee_structure_type: 'unknown',
  fee_schedule_verbatim: null,
  fee_tiers: null,
  flat_fee_pct: null,
  per_invoice_minimum_fee_usd: null,
  interest_base: 'unclear',
  minimum_charge_days: null,
  float_days: null,
  batch_billing: 'no',
  monthly_minimum: { found: 'no', description: null, amount_usd: null },
  term_months: null,
  auto_renewal: { found: 'no', renewal_period_months: null, description: null },
  cancellation_window: {
    found: 'no',
    description: null,
    notice_days_min: null,
    notice_days_max: null,
    certified_mail_required: 'no',
  },
  early_termination_fee: { found: 'no', structure: 'none_found', description: null, flat_amount_usd: null, pct_of_line: null },
  ucc_lien_scope: 'none_found',
  release_terms: { found: 'no', general_release_required: 'no', description: null },
  reserve_terms: { found: 'no', reserve_pct: null, withholding_rights_broad: 'no', description: null },
  whole_ledger_required: 'no',
  personal_guarantee: 'none_found',
  confession_of_judgment: 'no',
  asymmetric_exit_rights: { found: 'no', description: null },
  cross_collateralization: 'no',
  power_of_attorney: { found: 'no', scope_broad: 'no', description: null },
  misdirected_payment_penalty: { found: 'no', pct_of_face: null, description: null },
  concentration_limit: { found: 'no', description: null },
  ancillary_fees: [],
  factor_name: null,
  document_type: 'factoring_agreement',
  document_type_confidence_pct: 95,
  headline_rate_pct: null,
  annual_volume_usd: null,
  notable_quotes: [],
});

// ---- tiny assert harness ----
let passed = 0;
let failed = 0;
const results = [];
function check(label, actual, expected, tolerance = 0) {
  const ok =
    typeof expected === 'number' && tolerance > 0
      ? Math.abs(actual - expected) <= tolerance
      : actual === expected;
  results.push({ label, actual, expected, ok });
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}${tolerance ? ` (±${tolerance})` : ''}`);
}

// ============================================================
// 1. Corpay anchor: 2.5% flat, 85% advance, 30 days
// ============================================================
const corpay = ExtractionSchema.parse({
  ...baseExtraction(),
  fee_structure_type: 'flat',
  flat_fee_pct: 2.5,
  interest_base: 'full_invoice_face',
  advance_rate_pct: 85,
  headline_rate_pct: 2.5,
});
const corpayMath = runRateMath(corpay);
const corpay30 = corpayMath.scenarios.find((s) => s.days === 30);
check('Corpay 2.5%@30d face APR ~30%', corpay30.aprOnFace, 30.4, 0.3);
check('Corpay 2.5%@30d cash APR ~35-36%', corpay30.aprOnCash, 35.8, 0.5);
check('Corpay perceived APR = 2.5 x 12', corpayMath.perceived.aprSimple, 30, 0.01);

// ============================================================
// 2. fundingcompass-style: 2% at 30 days -> ~24% face APR
// ============================================================
const fc = ExtractionSchema.parse({
  ...baseExtraction(),
  fee_structure_type: 'flat',
  flat_fee_pct: 2.0,
  interest_base: 'full_invoice_face',
  advance_rate_pct: 90,
  headline_rate_pct: 2.0,
});
const fc30 = runRateMath(fc).scenarios.find((s) => s.days === 30);
check('fundingcompass 2%@30d face APR ~24%', fc30.aprOnFace, 24.3, 0.3);

// ============================================================
// 3. Bay View specimen: tiers 1.80% first 30d + 0.65% per 10d,
//    ETF months-remaining, general release required
// ============================================================
const bayview = ExtractionSchema.parse({
  ...baseExtraction(),
  factor_name: 'Bay View Funding',
  fee_structure_type: 'tiered_by_days',
  fee_schedule_verbatim: '1.80% of the gross face amount for the first 30 days, plus 0.65% for each 10 day period thereafter',
  fee_tiers: [
    { from_day: 1, to_day: 30, rate_pct: 1.8, block_days: null },
    { from_day: 31, to_day: null, rate_pct: 0.65, block_days: 10 },
  ],
  interest_base: 'full_invoice_face',
  advance_rate_pct: 85,
  headline_rate_pct: 1.8,
  auto_renewal: { found: 'yes', renewal_period_months: 1, description: 'automatically renewed for successive one (1) month periods' },
  early_termination_fee: {
    found: 'yes',
    structure: 'months_remaining_formula',
    description: '0.50% of the Maximum Credit multiplied by the number of months remaining; partial month counts as a full month',
    flat_amount_usd: null,
    pct_of_line: 0.5,
  },
  release_terms: {
    found: 'yes',
    general_release_required: 'yes',
    description: 'no obligation to terminate security interest until Seller executes a general release in a form acceptable to Purchaser',
  },
});

check('Bay View fee at day 30 = 1.80%', feePctForDays(bayview, 30), 1.8, 0.001);
check('Bay View fee at day 35 = 2.45%', feePctForDays(bayview, 35), 2.45, 0.001);
check('Bay View fee at day 45 = 3.10%', feePctForDays(bayview, 45), 3.1, 0.001);
check('Bay View fee at day 60 = 3.75%', feePctForDays(bayview, 60), 3.75, 0.001);
check('Bay View day-35 face APR ~25.5%/yr (research anchor)', Math.round(((2.45 / 35) * 365) * 10) / 10, 25.6, 0.2);

const bayReport = buildReport(bayview);
const flagIds = bayReport.allFlags.map((f) => f.id);
check('Bay View flags include rate_tier', flagIds.includes('rate_tier'), true);
check('Bay View flags include auto_renewal', flagIds.includes('auto_renewal'), true);
check('Bay View flags include etf', flagIds.includes('etf'), true);
check('Bay View flags include release_hostage', flagIds.includes('release_hostage'), true);
check('Bay View flags include full_face', flagIds.includes('full_face'), true);
check('Bay View verdict: worth a move', bayReport.visitor.verdict.canLikelyHelp, true);
check('Bay View visitor status ok', bayReport.visitor.status, 'ok');
check('Bay View visitor flags capped at 7', bayReport.visitor.flags.length <= 7, true);
check('Bay View internal has factor name', bayReport.extraction.factor_name, 'Bay View Funding');
check(
  'Bay View visitor payload never contains factor name',
  JSON.stringify(bayReport.visitor).includes('Bay View'),
  false,
);

// ============================================================
// 4. Honest no: competitive contract -> no savings headline
// ============================================================
const competitive = ExtractionSchema.parse({
  ...baseExtraction(),
  fee_structure_type: 'flat',
  flat_fee_pct: 1.2,
  interest_base: 'amount_advanced',
  advance_rate_pct: 90,
  headline_rate_pct: 1.2,
});
const compReport = buildReport(competitive);
check('Competitive contract verdict: keep it', compReport.visitor.verdict.canLikelyHelp, false);
check('Competitive contract: no savings headline', compReport.visitor.headline, null);

// ============================================================
// 5. Document gates
// ============================================================
const notFactoring = ExtractionSchema.parse({ ...baseExtraction(), document_type: 'not_financing', document_type_confidence_pct: 90 });
check('not_financing -> not_factoring status', buildReport(notFactoring).visitor.status, 'not_factoring');
const unreadable = ExtractionSchema.parse({ ...baseExtraction(), document_type: 'unreadable', document_type_confidence_pct: 0 });
check('unreadable -> unreadable status', buildReport(unreadable).visitor.status, 'unreadable');

// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
