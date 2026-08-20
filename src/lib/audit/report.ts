// Builds the report payload from extraction + rate math. Red flags ranked by
// severity then estimated dollar impact; visitor sees the top 5-7, Przemek gets
// the full list. The incumbent factor's name NEVER enters the visitor payload.
import type { Extraction } from './schema';
import { runRateMath, type RateMathResult } from './rate-math';
import { auditConfig } from '../../config/audit';

export type FlagSeverity = 'maximal' | 'critical' | 'high' | 'medium';

export interface RedFlag {
  id: string;
  severity: FlagSeverity;
  title: string;
  clauseQuote: string | null;
  plainEnglish: string;
  goodStandard: string;
  estAnnualImpactUsdPer100k: number | null;
}

export interface VisitorReport {
  status: 'ok' | 'not_factoring' | 'unreadable' | 'manual_review';
  headline: {
    savingsMinPerYear: number | null; // at volume when known
    savingsPerYearPer100k: number | null;
    volumeKnown: boolean;
  } | null;
  rates: {
    perceivedApr: number;
    effectiveAprAtTypical: number; // 45-day scenario, on cash received
    scenarios: { days: number; feePctOfFace: number; aprOnCash: number }[];
    advanceRatePct: number;
  } | null;
  flags: RedFlag[]; // top 5-7 only
  totalFlagCount: number;
  verdict: {
    canLikelyHelp: boolean;
    line: string;
  } | null;
  assumptions: string[];
  disclaimers: string[];
}

export interface InternalReport {
  extraction: Extraction; // includes factor_name; internal only
  math: RateMathResult | null;
  allFlags: RedFlag[];
  visitor: VisitorReport;
}

const q = (s: string | null | undefined) => (s && s.trim().length > 3 ? s.trim() : null);

export function buildFlags(x: Extraction, math: RateMathResult): RedFlag[] {
  const flags: RedFlag[] = [];
  const per100k = (pct: number) => Math.round((pct / 100) * 100_000);
  const typical = math.scenarios.find((s) => s.days === 45) ?? math.scenarios[0];

  // ---- rate mechanics
  if (x.fee_structure_type === 'tiered_by_days' && (x.fee_tiers?.length ?? 0) > 0) {
    const day30 = math.scenarios.find((s) => s.days === 30);
    const day60 = math.scenarios.find((s) => s.days === 60);
    const escalation = day60 && day30 ? day60.feePctOfFace - day30.feePctOfFace : null;
    flags.push({
      id: 'rate_tier',
      severity: 'high',
      title: 'The rate escalates after the first tier',
      clauseQuote: q(x.fee_schedule_verbatim),
      plainEnglish:
        'The rate you remember is the day-1 tier. Every block your customer takes to pay stacks another charge on top, so slow months bill far above the headline.',
      goodStandard: 'A daily rate: the invoice costs exactly the days it took, no tier jumps.',
      estAnnualImpactUsdPer100k: escalation ? per100k(escalation) : null,
    });
  }

  if (x.interest_base === 'full_invoice_face') {
    const upliftPct = typical.feePctOfFace * (100 / math.advanceRatePct) - typical.feePctOfFace;
    flags.push({
      id: 'full_face',
      severity: 'high',
      title: 'Fees are charged on the full invoice, not your advance',
      clauseQuote: null,
      plainEnglish: `You received roughly ${math.advanceRatePct}% of each invoice, but the percentage is computed on 100% of it. You pay fees on money you never held.`,
      goodStandard: 'Interest only on the amount actually advanced to you.',
      estAnnualImpactUsdPer100k: per100k(upliftPct),
    });
  }

  if ((x.minimum_charge_days ?? 0) >= 15) {
    flags.push({
      id: 'min_days',
      severity: 'high',
      title: `A ${x.minimum_charge_days}-day minimum charge on every invoice`,
      clauseQuote: null,
      plainEnglish: `Invoices that pay fast are billed as if they took ${x.minimum_charge_days} days. Your best-paying customers subsidize the contract.`,
      goodStandard: 'A daily rate means a 7-day invoice costs 7 days.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if ((x.float_days ?? 0) > 3) {
    flags.push({
      id: 'float_days',
      severity: 'medium',
      title: `${x.float_days} clearing days charged after payment`,
      clauseQuote: null,
      plainEnglish:
        'The meter keeps running for days after your customer already paid. The industry’s own training manual calls anything past 2 or 3 days unreasonable.',
      goodStandard: 'No float. Paid means paid.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.batch_billing === 'yes') {
    flags.push({
      id: 'batch_billing',
      severity: 'medium',
      title: 'Whole schedules billed at the slowest invoice’s rate',
      clauseQuote: null,
      plainEnglish: 'Ten invoices in a batch all pay the rate of the one that dragged. Fast payers get billed like slow ones.',
      goodStandard: 'Each invoice billed on its own timeline.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.monthly_minimum.found === 'yes') {
    const forced = x.monthly_minimum.forced_with_penalty === 'yes';
    flags.push({
      id: 'monthly_min',
      severity: forced ? 'high' : 'medium',
      title: forced ? 'A forced monthly minimum' : 'A monthly minimum regardless of your volume',
      clauseQuote: q(x.monthly_minimum.description),
      plainEnglish: forced
        ? 'Miss the number and you owe the shortfall anyway. If you factor everything you have, this may never bite; the clause exists for the months it does, and those are your slowest ones.'
        : 'Slow months still owe the factor its minimum, which makes your quiet season the most expensive money in the contract.',
      goodStandard: 'Pay for what you factor. No shortfall penalty.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  // ---- timing layer (2026-08-05: when the meter starts + funding speed)
  if (x.advance_timing?.client_controls_timing === 'no') {
    flags.push({
      id: 'meter_start',
      severity: 'medium',
      title: 'The meter starts the day you invoice',
      clauseQuote: q(x.advance_timing.description),
      plainEnglish:
        'Advances, and the fees on them, begin at invoice purchase whether you needed the cash that day or not. You pay to have money sit in your account before payroll is due.',
      goodStandard:
        'You schedule the advance for the day you actually need the money: payroll day, supplier day. The meter starts then.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  const speed = x.funding_speed;
  if (speed?.found === 'yes' && ((speed.business_days_min ?? 0) >= 2 || (speed.same_day_surcharge_usd ?? 0) > 0)) {
    const surcharged = (speed.same_day_surcharge_usd ?? 0) > 0;
    flags.push({
      id: 'funding_speed',
      severity: 'medium',
      title: surcharged ? 'Same-day funding costs extra here' : 'Your money takes days to arrive',
      clauseQuote: q(speed.stated_timeline),
      plainEnglish: surcharged
        ? `Getting your own receivable the day you ask carries a $${speed.same_day_surcharge_usd} surcharge. Speed is sold back to you as an add-on.`
        : 'You request funds because you need them that day. A two or three day wait turns your own receivable into a scheduling problem.',
      goodStandard: 'Same-day funding, no surcharge.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  // ---- the junk-fee stack (2026-08-05, Darren's list)
  if (x.monitoring_fee?.found === 'yes') {
    flags.push({
      id: 'monitoring_fee',
      severity: 'medium',
      title: `A monthly monitoring fee${x.monitoring_fee.amount_usd ? ` of $${x.monitoring_fee.amount_usd}` : ''}`,
      clauseQuote: q(x.monitoring_fee.quote),
      plainEnglish:
        'A recurring line item for "monitoring" the account you already pay factoring fees on. It has nothing to do with advancing you money and everything to do with padding the bill.',
      goodStandard: 'No monitoring fee.',
      estAnnualImpactUsdPer100k: x.monitoring_fee.amount_usd ? Math.round(x.monitoring_fee.amount_usd * 12) : null,
    });
  }

  if ((x.wire_fee_usd ?? 0) >= 15) {
    flags.push({
      id: 'wire_fees',
      severity: 'medium',
      title: `$${x.wire_fee_usd} wires`,
      clauseQuote: null,
      plainEnglish:
        'A wire costs a fraction of this to send. Charged on every transfer, the spread quietly adds up to real money over a high-volume year.',
      goodStandard: 'Wires near cost, or deposit options that skip the fee entirely.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.new_debtor_credit_fee?.found === 'yes') {
    flags.push({
      id: 'onboarding_fee',
      severity: 'medium',
      title: `A fee every time you add a customer${x.new_debtor_credit_fee.amount_usd ? ` ($${x.new_debtor_credit_fee.amount_usd})` : ''}`,
      clauseQuote: q(x.new_debtor_credit_fee.quote),
      plainEnglish:
        'Running credit on a new account debtor is the factor\'s own underwriting, billed to you. It is a tax on growing your book.',
      goodStandard: 'New customers underwritten at no charge.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.due_diligence_fee?.found === 'yes') {
    flags.push({
      id: 'due_diligence',
      severity: 'medium',
      title: `A due diligence fee${x.due_diligence_fee.amount_usd ? ` of $${x.due_diligence_fee.amount_usd}` : ''}`,
      clauseQuote: q(x.due_diligence_fee.quote),
      plainEnglish:
        'You paid just to be looked at. Fees like this run as high as $2,500 in the market, sometimes just to get declined, and they are a big part of why owners never shop their contract.',
      goodStandard: 'No due diligence fee. Looking should never cost you money.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  // ---- exit layer
  if (x.auto_renewal.found === 'yes') {
    flags.push({
      id: 'auto_renewal',
      severity: 'critical',
      title: 'The contract renews itself',
      clauseQuote: q(x.auto_renewal.description),
      plainEnglish:
        'Miss the notice window and the whole term re-signs automatically. Most owners find out the week they try to leave.',
      goodStandard: 'Month-to-month after the initial term, or a clean dated exit in writing.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.cancellation_window.found === 'yes') {
    flags.push({
      id: 'exit_window',
      severity: 'critical',
      title: 'Exit only inside a narrow notice window',
      clauseQuote: q(x.cancellation_window.description),
      plainEnglish: `Leaving requires written notice inside a specific window${
        x.cancellation_window.certified_mail_required === 'yes' ? ', by certified mail' : ''
      }. Outside that window, the door is closed for another term.`,
      goodStandard: 'Exit terms you can act on any month, in writing before you sign.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.early_termination_fee.found === 'yes') {
    flags.push({
      id: 'etf',
      severity: 'critical',
      title: 'An early termination fee guards the door',
      clauseQuote: q(x.early_termination_fee.description),
      plainEnglish:
        x.early_termination_fee.structure === 'months_remaining_formula'
          ? 'The exit fee scales with every month left on the term, so the price of leaving is highest exactly when you most want out.'
          : 'Leaving before the anniversary costs a fee on top of everything else owed.',
      goodStandard: 'No fee for leaving a deal that stopped working for you.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.release_terms.general_release_required === 'yes') {
    flags.push({
      id: 'release_hostage',
      severity: 'critical',
      title: 'The lien release is conditioned on signing a general release',
      clauseQuote: q(x.release_terms.description),
      plainEnglish:
        'The factor is not required to clear its UCC filing until you sign a release in a form it finds acceptable. This is the documented release-letter hostage pattern, and some contracts make you waive your UCC 9-513 timing rights outright.',
      goodStandard: 'UCC termination on payoff, on the statutory clock, no strings.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.asymmetric_exit_rights.found === 'yes') {
    flags.push({
      id: 'asymmetric_exit',
      severity: 'high',
      title: 'They can leave anytime. You cannot.',
      clauseQuote: q(x.asymmetric_exit_rights.description),
      plainEnglish: 'The factor can exit on short notice at will while you are locked to an anniversary window.',
      goodStandard: 'Exit rights that read the same in both directions.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.ucc_lien_scope === 'all_assets') {
    flags.push({
      id: 'ucc_all_assets',
      severity: 'high',
      title: 'The UCC lien covers everything you own, not just receivables',
      clauseQuote: null,
      plainEnglish:
        'A blanket first-position lien makes every other lender walk away until it clears. It is the mechanism behind "no other factoring company will work with you."',
      goodStandard: 'A lien scoped to the receivables actually purchased.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  // ---- control layer
  if (x.whole_ledger_required === 'yes') {
    flags.push({
      id: 'whole_ledger',
      severity: 'high',
      title: 'Every customer, every invoice, or you are in breach',
      clauseQuote: null,
      plainEnglish:
        'Your 20-day payers fund the factor’s margin, and quietly holding invoices back is a default waiting to happen.',
      goodStandard:
        'You choose which customers go into your borrowing base and draw any amount from zero to 90% of that AR, like a line of credit.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.personal_guarantee === 'full_pg') {
    flags.push({
      id: 'full_pg',
      severity: 'high',
      title: 'A full personal guarantee, not a validity guarantee',
      clauseQuote: null,
      plainEnglish:
        'You are personally on the hook even when a customer simply fails to pay. A validity guarantee (you only guarantee the invoices are real) is the factoring-native standard.',
      goodStandard: 'Validity guarantee only: the factor keeps the credit risk it is paid to take.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.confession_of_judgment === 'yes') {
    flags.push({
      id: 'coj',
      severity: 'maximal',
      title: 'A confession of judgment',
      clauseQuote: null,
      plainEnglish:
        'You pre-sign away your right to defend yourself in court. This practice drew federal enforcement in adjacent industries and is restricted in several states. Show this contract to an attorney.',
      goodStandard: 'No confession of judgment, ever.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.cross_collateralization === 'yes') {
    flags.push({
      id: 'cross_collateral',
      severity: 'high',
      title: 'Cross-collateralization / cross-default language',
      clauseQuote: null,
      plainEnglish: 'A breach anywhere becomes recoverable everywhere. One dispute can put unrelated collateral in play.',
      goodStandard: 'Obligations scoped to this facility alone.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.misdirected_payment_penalty.found === 'yes' && (x.misdirected_payment_penalty.pct_of_face ?? 0) >= 5) {
    flags.push({
      id: 'misdirected',
      severity: 'high',
      title: `A ${x.misdirected_payment_penalty.pct_of_face}% penalty for misdirected payments`,
      clauseQuote: q(x.misdirected_payment_penalty.description),
      plainEnglish:
        'A customer paying you directly by mistake triggers a penalty on the invoice face. Real contracts set this as high as 10%.',
      goodStandard: 'Forward the payment, no punitive charge.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  if (x.reserve_terms.withholding_rights_broad === 'yes') {
    flags.push({
      id: 'reserve_rights',
      severity: 'high',
      title: 'Broad rights to hold your reserves',
      clauseQuote: q(x.reserve_terms.description),
      plainEnglish:
        'The right to withhold your reserve balance is written wide open. The industry’s own manual calls these rights "nebulous."',
      goodStandard: 'Defined reserve release timing you can hold them to.',
      estAnnualImpactUsdPer100k: null,
    });
  }

  const sevRank: Record<FlagSeverity, number> = { maximal: 0, critical: 1, high: 2, medium: 3 };
  flags.sort(
    (a, b) =>
      sevRank[a.severity] - sevRank[b.severity] ||
      (b.estAnnualImpactUsdPer100k ?? 0) - (a.estAnnualImpactUsdPer100k ?? 0),
  );
  return flags;
}

const DISCLAIMERS = [
  'This audit is an automated estimate from the document you provided, subject to human confirmation. It is a ballpark, not a binding quote.',
  'Not legal advice and not accounting or tax advice. Consult an attorney before terminating or signing any agreement.',
  'Actual savings depend on invoice volume, payment timing, and final factor pricing, confirmed in writing before you sign anything.',
];

export function buildReport(x: Extraction): InternalReport {
  // Document sanity gates first: honest states, no fake savings numbers.
  if (x.document_type === 'unreadable') {
    return wrap(x, null, [], {
      status: 'unreadable',
      headline: null,
      rates: null,
      flags: [],
      totalFlagCount: 0,
      verdict: null,
      assumptions: [],
      disclaimers: DISCLAIMERS,
    });
  }
  if (x.document_type === 'not_financing' || x.document_type === 'other_financing' || x.document_type_confidence_pct < 40) {
    return wrap(x, null, [], {
      status: 'not_factoring',
      headline: null,
      rates: null,
      flags: [],
      totalFlagCount: 0,
      verdict: null,
      assumptions: [],
      disclaimers: DISCLAIMERS,
    });
  }

  const math = runRateMath(x);
  const allFlags = buildFlags(x, math);
  const typical = math.scenarios.find((s) => s.days === 45) ?? math.scenarios[0];

  const hasLockIn = allFlags.some((f) => f.severity === 'maximal' || f.severity === 'critical');
  const competitive =
    typical.monthlyEquivalentPctOnCash <= auditConfig.competitiveMonthlyEquivalentPct && !hasLockIn;

  const savingsAtVolume = math.savings.perYearAtVolume;
  const savingsPer100k = math.savings.perYearPer100kFace;
  const meaningfulSavings =
    (savingsAtVolume ?? savingsPer100k) >= auditConfig.minSavingsToDisplayUsd && !competitive;

  const verdictLine = competitive
    ? 'Honest answer: your contract is actually competitive. The rate mechanics are fair and we did not find lock-in traps worth a move. Keep it, and keep this report for your renewal window.'
    : 'Based on this ballpark read, better terms very likely exist for you. A specialist will confirm the real number against your volume before anything moves.';

  const visitor: VisitorReport = {
    status: 'ok',
    headline: meaningfulSavings
      ? {
          savingsMinPerYear: savingsAtVolume,
          savingsPerYearPer100k: savingsPer100k,
          volumeKnown: savingsAtVolume != null,
        }
      : null,
    rates: {
      perceivedApr: math.perceived.aprSimple,
      effectiveAprAtTypical: typical.aprOnCash,
      scenarios: math.scenarios.map((s) => ({ days: s.days, feePctOfFace: s.feePctOfFace, aprOnCash: s.aprOnCash })),
      advanceRatePct: math.advanceRatePct,
    },
    flags: allFlags.slice(0, 7),
    totalFlagCount: allFlags.length,
    verdict: { canLikelyHelp: !competitive, line: verdictLine },
    assumptions: math.assumptions,
    disclaimers: DISCLAIMERS,
  };

  return wrap(x, math, allFlags, visitor);
}

function wrap(x: Extraction, math: RateMathResult | null, allFlags: RedFlag[], visitor: VisitorReport): InternalReport {
  return { extraction: x, math, allFlags, visitor };
}

/** Visitor report for pipeline failures: the lead is captured, a human takes over. */
export function buildManualReviewReport(): VisitorReport {
  return {
    status: 'manual_review',
    headline: null,
    rates: null,
    flags: [],
    totalFlagCount: 0,
    verdict: null,
    assumptions: [],
    disclaimers: DISCLAIMERS,
  };
}
