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
      export { buildCompletionPayload } from './src/lib/audit/webhooks';
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
const { ExtractionSchema, runRateMath, feePctForDays, buildReport, buildCompletionPayload } = lib;

// ---- fixture builder: every field present, "nothing found" defaults ----
const baseExtraction = () => ({
  advance_rate_pct: null,
  fee_structure_type: 'unknown',
  fee_schedule_verbatim: null,
  fee_tiers: null,
  flat_fee_pct: null,
  per_invoice_minimum_fee_usd: null,
  interest_base: 'unclear',
  interest_charge: { found: 'no', annual_rate_pct: null, index: 'none', spread_pct: null, floor_annual_pct: null, day_count: null, basis: 'unclear', description: null },
  minimum_charge_days: null,
  float_days: null,
  batch_billing: 'no',
  monthly_minimum: { found: 'no', description: null, amount_usd: null, forced_with_penalty: 'no' },
  advance_timing: { found: 'no', client_controls_timing: 'unclear', description: null },
  funding_speed: { found: 'no', stated_timeline: null, business_days_min: null, same_day_available: 'unclear', same_day_surcharge_usd: null },
  monitoring_fee: { found: 'no', amount_usd: null, quote: null },
  wire_fee_usd: null,
  ach_fee_usd: null,
  new_debtor_credit_fee: { found: 'no', amount_usd: null, quote: null },
  due_diligence_fee: { found: 'no', amount_usd: null, quote: null },
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
check('Bay View visitor sees every flag (2026-08-24: no cap)', bayReport.visitor.flags.length, bayReport.allFlags.length);
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
check('Visitor payload carries no dollar-savings headline (cut 2026-10-02)', 'headline' in compReport.visitor, false);

// ============================================================
// 5. Document gates
// ============================================================
const notFactoring = ExtractionSchema.parse({ ...baseExtraction(), document_type: 'not_financing', document_type_confidence_pct: 90 });
check('not_financing -> not_factoring status', buildReport(notFactoring).visitor.status, 'not_factoring');
const unreadable = ExtractionSchema.parse({ ...baseExtraction(), document_type: 'unreadable', document_type_confidence_pct: 0 });
check('unreadable -> unreadable status', buildReport(unreadable).visitor.status, 'unreadable');

// ============================================================
// 6. 2026-08-05 additions: better-contract behavior levers +
//    the timing/junk-fee flag set (homepage checklist congruence)
// ============================================================
// Better-contract cost with the two levers, hand-computed:
//   daily = 1.5% x 12 / 365 = 0.049315%/day
//   30d scenario: 0.049315 x (30 x 0.85) x 0.90 (advance) x 0.90 (utilization) = 1.02% of face
check('Better-contract cost @30d with levers = 1.02% of face', corpay30.goodFactorCostPctOfFace, 1.02, 0.01);
check(
  'Lever assumptions disclosed in report assumptions',
  corpayMath.assumptions.some((a) => a.includes('85%') && a.includes('90%')),
  true,
);

// Kitchen-sink fixture: every new flag fires + forced minimum promotes to high.
const junky = ExtractionSchema.parse({
  ...baseExtraction(),
  fee_structure_type: 'flat',
  flat_fee_pct: 2.5,
  interest_base: 'full_invoice_face',
  advance_rate_pct: 85,
  headline_rate_pct: 2.5,
  monthly_minimum: { found: 'yes', description: 'minimum monthly fees of $2,500; shortfall billed', amount_usd: 2500, forced_with_penalty: 'yes' },
  advance_timing: { found: 'yes', client_controls_timing: 'no', description: 'Purchaser shall advance upon purchase of each invoice' },
  funding_speed: { found: 'yes', stated_timeline: 'within three (3) business days of purchase', business_days_min: 3, same_day_available: 'no', same_day_surcharge_usd: null },
  monitoring_fee: { found: 'yes', amount_usd: 95, quote: 'monthly monitoring fee of $95' },
  wire_fee_usd: 19,
  ach_fee_usd: 5,
  new_debtor_credit_fee: { found: 'yes', amount_usd: 45, quote: 'credit review fee of $45 per new account debtor' },
  due_diligence_fee: { found: 'yes', amount_usd: 2500, quote: 'due diligence fee of $2,500' },
});
const junkyReport = buildReport(junky);
const junkyIds = junkyReport.allFlags.map((f) => f.id);
check('meter_start flag fires', junkyIds.includes('meter_start'), true);
check('funding_speed flag fires', junkyIds.includes('funding_speed'), true);
check('monitoring_fee flag fires', junkyIds.includes('monitoring_fee'), true);
check('wire_fees flag fires at $19', junkyIds.includes('wire_fees'), true);
check('onboarding_fee flag fires', junkyIds.includes('onboarding_fee'), true);
check('due_diligence flag fires', junkyIds.includes('due_diligence'), true);
check(
  'forced monthly minimum promotes to high severity',
  junkyReport.allFlags.find((f) => f.id === 'monthly_min')?.severity,
  'high',
);
check(
  'monitoring fee carries $/yr impact',
  junkyReport.allFlags.find((f) => f.id === 'monitoring_fee')?.estAnnualImpactUsdPer100k,
  95 * 12,
);
check('no "predatory" anywhere in visitor payload', JSON.stringify(junkyReport.visitor).toLowerCase().includes('predatory'), false);

// Near-cost wire ($11) must NOT flag; quiet contract fires none of the new set.
const quietWire = ExtractionSchema.parse({ ...baseExtraction(), wire_fee_usd: 11 });
const quietIds = buildReport(quietWire).allFlags.map((f) => f.id);
check('$11 wire does not flag', quietIds.includes('wire_fees'), false);
const noneIds = buildReport(ExtractionSchema.parse(baseExtraction())).allFlags.map((f) => f.id);
check(
  'nothing-found contract fires none of the new flag set',
  ['meter_start', 'funding_speed', 'monitoring_fee', 'wire_fees', 'onboarding_fee', 'due_diligence'].some((id) => noneIds.includes(id)),
  false,
);

// ============================================================
// 7. 2026-10-02: commission + interest contracts (Middlegate Factors,
//    the first real contract through the live tool). 1% commission on the
//    gross receivable + interest at prime + 2% (floor 6%, 360-day year) on
//    sums advanced, 85% advance, 5 business clearing days. The old math
//    scored this as a flat 1% scaled by the advance (0.85% of face, 8.1%/yr
//    on cash at 45 days, BELOW the 12% perceived). Hand-computed at prime 7.00:
//      45d, billed 50: commission 1.00 + interest 0.85 x 9% x 50/360 = 1.0625
//        -> 2.06% of face -> 2.06/0.85/45 x 365 = 19.7%/yr on cash
//      30d, billed 35: 1.00 + 0.74 = 1.74% -> 24.9%/yr
//      60d, billed 65: 1.00 + 1.38 = 2.38% -> 17.0%/yr
// ============================================================
const middlegate = ExtractionSchema.parse({
  ...baseExtraction(),
  factor_name: 'Middlegate Factors LLC',
  fee_structure_type: 'admin_plus_interest',
  fee_schedule_verbatim: 'a commission upon the gross amount of the Receivables ... One percent (1.00%)',
  flat_fee_pct: 1.0,
  interest_base: 'full_invoice_face',
  interest_charge: {
    found: 'yes',
    annual_rate_pct: null,
    index: 'prime',
    spread_pct: 2,
    floor_annual_pct: 6,
    day_count: 360,
    basis: 'amount_advanced',
    description: 'two percent (2%) in excess of the prime commercial interest rate ... in no event less than 6% per annum (360 day year) ... on the average daily balance of all sums advanced',
  },
  advance_rate_pct: 85,
  float_days: 5,
  headline_rate_pct: 1.0,
  wire_fee_usd: 40,
  due_diligence_fee: { found: 'yes', amount_usd: 0, quote: 'one time set up fee of $00.00' },
  auto_renewal: { found: 'yes', renewal_period_months: 24, description: 'automatically renewed for successive like periods of the same duration' },
});
const mgMath = runRateMath(middlegate);
const mg30 = mgMath.scenarios.find((s) => s.days === 30);
const mg45 = mgMath.scenarios.find((s) => s.days === 45);
const mg60 = mgMath.scenarios.find((s) => s.days === 60);
check('Middlegate interest leg resolved at prime 7 + 2 = 9%', mgMath.interest?.annualRatePct, 9, 0.001);
check('Middlegate interest label reads prime + 2%', mgMath.interest?.label, 'prime + 2%');
check('Middlegate 45d commission = 1.00% of face (on gross, not scaled by advance)', mg45.commissionPctOfFace, 1.0, 0.001);
check('Middlegate 45d interest = 1.06% of face (85% x 9% x 50/360)', mg45.interestPctOfFace, 1.06, 0.01);
check('Middlegate 45d total = 2.06% of face', mg45.feePctOfFace, 2.06, 0.01);
check('Middlegate 45d APR on cash ~19.7% (was 8.1 before the fix)', mg45.aprOnCash, 19.7, 0.2);
check('Middlegate 30d APR on cash ~24.9%', mg30.aprOnCash, 24.9, 0.2);
check('Middlegate 60d APR on cash ~17.0%', mg60.aprOnCash, 17.0, 0.2);
check('Middlegate actual now ABOVE perceived 12%', mg45.aprOnCash > mgMath.perceived.aprSimple, true);
check('Middlegate prime assumption disclosed with date', mgMath.assumptions.some((a) => a.includes('prime') && a.includes('2026-09-30')), true);

const mgReport = buildReport(middlegate);
const mgIds = mgReport.allFlags.map((f) => f.id);
check('Middlegate flags interest_on_top', mgIds.includes('interest_on_top'), true);
check('Middlegate interest_on_top carries the interest $/yr per 100K', mgReport.allFlags.find((f) => f.id === 'interest_on_top')?.estAnnualImpactUsdPer100k, 1060, 15);
check('Middlegate full_face uplift uses the commission leg only (~$176/100K)', mgReport.allFlags.find((f) => f.id === 'full_face')?.estAnnualImpactUsdPer100k, 176, 2);
check('Middlegate $0.00 set up fee does NOT flag due diligence', mgIds.includes('due_diligence'), false);
check('Middlegate visitor rates flag includesInterest', mgReport.visitor.rates.includesInterest, true);
check('Middlegate visitor effective = 45d on cash', mgReport.visitor.rates.effectiveAprAtTypical, mg45.aprOnCash, 0.001);

// Floor wins when index + spread sits under it; fixed rate wins over index.
const floored = ExtractionSchema.parse({
  ...middlegate,
  interest_charge: { ...middlegate.interest_charge, spread_pct: -3, floor_annual_pct: 6 },
});
check('Interest floor applies (prime 7 - 3 = 4 -> floor 6)', runRateMath(floored).interest?.annualRatePct, 6, 0.001);
const fixed = ExtractionSchema.parse({
  ...middlegate,
  interest_charge: { ...middlegate.interest_charge, annual_rate_pct: 12, index: 'none', spread_pct: null, day_count: 365 },
});
const fixed45 = runRateMath(fixed).scenarios.find((s) => s.days === 45);
check('Fixed 12% on advance, 365-day: 45d interest = 0.85 x 12 x 50/365 = 1.40%', fixed45.interestPctOfFace, 1.4, 0.01);

// No interest leg: nothing changes for flat / tiered contracts.
check('Flat contract has no interest leg', corpayMath.interest, null);
check('Flat contract interest % of face = 0', corpay30.interestPctOfFace, 0, 0.001);
check('Flat contract does not flag interest_on_top', buildReport(corpay).allFlags.some((f) => f.id === 'interest_on_top'), false);
check('Flat contract total = commission (unchanged 2.5%)', corpay30.feePctOfFace, 2.5, 0.001);
// admin_plus_interest with no flat_fee_pct: the headline is charged ONCE, never per block.
const noFlat = ExtractionSchema.parse({ ...middlegate, flat_fee_pct: null });
check('admin_plus_interest fallback charges the headline once at 60d', feePctForDays(noFlat, 65), 1.0, 0.001);

// ============================================================
// 8. Przemek's completion payload builds cleanly (2026-10-02: the second
//    live audit reached the visitor and never reached Przemek; the webhook
//    now fires before the done signal and the builder is exercised here).
// ============================================================
const fakeJob = {
  id: 'job-test',
  createdAt: '2026-10-02T12:00:00Z',
  lead: { name: 'Test', email: 't@example.com', phone: '5555550100' },
  files: [{ url: 'https://x.public.blob.vercel-storage.com/contracts/a/b.pdf', pathname: 'contracts/a/b.pdf', contentType: 'application/pdf' }],
  consent: { text: 'x', clientTimestamp: '', url: '', ip: '', userAgent: '', receivedAt: '' },
};
const completion = buildCompletionPayload(fakeJob, mgReport, { manualReview: false });
check('completion payload: factor name present for Przemek', completion.factorName, 'Middlegate Factors LLC');
check('completion payload: terms table carries the interest terms', completion.termsTable.some((r) => r.field === 'Interest rate terms' && r.value.includes('prime + 2%')), true);
check('completion payload: summary line stacks commission + interest', completion.summaryText.includes('commission 1% + interest 1.06%'), true);
check('completion payload: every flag included', completion.flags.length, mgReport.allFlags.length);
const manual = buildCompletionPayload(fakeJob, null, { manualReview: true, manualReviewReason: 'test' });
check('completion payload: manual-review path flags manualReview', manual.manualReview, true);
check('completion payload: manual-review path has no factor name', manual.factorName, null);
check('completion payload: manual-review path has no terms table', manual.termsTable, undefined);

// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
