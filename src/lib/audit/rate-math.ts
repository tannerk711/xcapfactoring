// Deterministic rate math. The model extracts terms; THIS file computes every
// number the visitor sees. Formula components sourced in
// context/modern-factoring-research.md section 7:
//   effective rate = (all fees + interest) / (cash actually received) x (365 / days outstanding)
// stacking: tier/block escalation + fee base (face vs advance) + minimum-days
// charge + float days + (2026-10-02) interest on advances for commission +
// interest contracts, with monthly minimums handled as an uplift when volume is known.
import type { Extraction } from './schema';
import { auditConfig } from '../../config/audit';

export interface ScenarioResult {
  days: number; // invoice pays on this day
  billedDays: number; // after minimum-days and float stacking
  commissionPctOfFace: number; // the discount / commission leg, as % of invoice face
  interestPctOfFace: number; // the interest-on-advances leg, as % of invoice face (0 when none)
  feePctOfFace: number; // TOTAL charged, as % of invoice face (commission + interest)
  aprOnFace: number; // annualized on face (the convention published rates use)
  aprOnCash: number; // annualized on cash actually received (the honest number)
  monthlyEquivalentPctOnCash: number;
  goodFactorCostPctOfFace: number; // same scenario at the good-factor standard
}

export interface InterestLeg {
  found: boolean;
  annualRatePct: number; // the rate the math used (index + spread, floored, or the fixed rate)
  label: string; // "prime + 2%" or "9%"
  dayCount: number;
  basisPctOfFace: number; // 1 = face, advance rate / 100 = advance
  indexUsed: { label: string; pct: number; asOf: string } | null;
}

export interface RateMathResult {
  scenarios: ScenarioResult[];
  perceived: {
    headlineMonthlyPct: number;
    headlineAssumed: boolean;
    aprSimple: number; // headline x 12: "what you think you pay"
  };
  advanceRatePct: number;
  advanceRateAssumed: boolean;
  interest: InterestLeg | null; // null when the contract has no interest leg
  monthlyMinimumUpliftUsdPerYear: number | null; // only when volume + minimum known
  savings: SavingsResult;
  assumptions: string[];
}

export interface SavingsResult {
  perYearPer100kFace: number; // conservative (min across scenarios, floored at 0)
  perYearAtVolume: number | null; // when annual volume extractable
  volumeUsd: number | null;
  conservativeScenarioDays: number;
}

/** Commission / discount fee % of face for a given number of billed days under the extracted schedule. */
export function feePctForDays(x: Extraction, billedDays: number): number {
  const tiers = x.fee_tiers ?? [];

  // Flat structure: one rate per invoice regardless of days. Also the shape of
  // the commission leg in commission + interest contracts (a % of the gross
  // invoice, charged once; the time cost lives in the interest leg).
  if (tiers.length === 0 && x.flat_fee_pct != null) {
    return x.flat_fee_pct;
  }

  if (tiers.length === 0) {
    const monthly = x.headline_rate_pct ?? auditConfig.assumptions.headlineMonthlyPctWhenUnknown;
    if (x.fee_structure_type === 'admin_plus_interest') {
      // Commission charged once per invoice; never prorate it in 30-day blocks
      // or the interest leg gets double-counted.
      return monthly;
    }
    // No schedule extracted: fall back to headline rate prorated in 30-day blocks
    // (block accrual: partial blocks bill as full blocks, the documented doctrine).
    const blocks = Math.max(1, Math.ceil(billedDays / 30));
    return monthly * blocks;
  }

  // Tiered/block accrual: charge each tier's rate for every started block the
  // billed days reach into. Example (Bay View, SEC-filed): 1.80% first 30 days
  // + 0.65% per 10 days after. Day 35 bills 1.80 + 0.65 = 2.45%.
  let pct = 0;
  const sorted = [...tiers].sort((a, b) => a.from_day - b.from_day);
  for (const t of sorted) {
    if (billedDays < t.from_day) break;
    const spanEnd = t.to_day ?? Infinity;
    if (t.block_days && t.block_days > 0) {
      // Repeating block tier: count started blocks within [from_day, min(billedDays, spanEnd)]
      const daysInto = Math.min(billedDays, spanEnd) - t.from_day + 1;
      const blocks = Math.max(0, Math.ceil(daysInto / t.block_days));
      pct += blocks * t.rate_pct;
    } else {
      // Single-span tier: bills once when reached
      pct += t.rate_pct;
    }
  }
  return pct;
}

/**
 * Resolve the interest leg (commission + interest contracts). Fixed rate when
 * stated; otherwise index + spread from config, floored by the contract floor.
 * Returns null when the document has no interest charge.
 */
export function resolveInterestLeg(x: Extraction, advanceRatePct: number, assumptions: string[]): InterestLeg | null {
  const ic = x.interest_charge;
  if (!ic || ic.found !== 'yes') return null;

  const prime = auditConfig.indexRates.prime;
  let annualRatePct: number | null = null;
  let label = '';
  let indexUsed: InterestLeg['indexUsed'] = null;

  if (ic.annual_rate_pct != null) {
    annualRatePct = ic.annual_rate_pct;
    label = `${ic.annual_rate_pct}%`;
  } else if (ic.index === 'prime') {
    const spread = ic.spread_pct ?? 0;
    annualRatePct = prime.pct + spread;
    label = spread ? `prime + ${spread}%` : 'prime';
    indexUsed = { label: prime.label, pct: prime.pct, asOf: prime.asOf };
    assumptions.push(
      `Interest on advances modeled at ${prime.label} ${prime.pct}% (as of ${prime.asOf})${spread ? ` plus the ${spread}% spread in your contract` : ''}, ${annualRatePct}% per year.`,
    );
  } else if (ic.floor_annual_pct != null) {
    // Indexed to something we do not track: the contract floor is the honest minimum.
    annualRatePct = ic.floor_annual_pct;
    label = `${ic.floor_annual_pct}% (contract floor)`;
    assumptions.push(
      `Interest on advances is indexed to a rate not modeled here; the ${ic.floor_annual_pct}% contract floor is used, so the real figure is at least this.`,
    );
  } else {
    assumptions.push('Interest on advances is charged but its rate could not be determined from the document; it is left out of the figures, so the real cost is higher than shown.');
    return null;
  }

  if (ic.floor_annual_pct != null && annualRatePct < ic.floor_annual_pct) {
    annualRatePct = ic.floor_annual_pct;
    label = `${ic.floor_annual_pct}% (contract floor)`;
  }

  const dayCount = ic.day_count === 360 ? 360 : 365;
  let basisPctOfFace = advanceRatePct / 100;
  if (ic.basis === 'full_invoice_face') basisPctOfFace = 1;
  if (ic.basis === 'unclear') {
    assumptions.push('Interest base (invoice face vs amount advanced) unclear in the document; math assumes amount advanced, the cheaper reading.');
  }

  return { found: true, annualRatePct, label, dayCount, basisPctOfFace, indexUsed };
}

export function runRateMath(x: Extraction): RateMathResult {
  const assumptions: string[] = [];

  const advanceRateAssumed = x.advance_rate_pct == null;
  const advanceRatePct = x.advance_rate_pct ?? auditConfig.assumptions.advanceRatePctWhenUnknown;
  if (advanceRateAssumed) {
    assumptions.push(`Advance rate not found in the document; assumed ${advanceRatePct}% (typical range 85 to 90%).`);
  }

  const headlineAssumed = x.headline_rate_pct == null;
  const headlineMonthlyPct = x.headline_rate_pct ?? auditConfig.assumptions.headlineMonthlyPctWhenUnknown;
  if (headlineAssumed) {
    assumptions.push(`Headline rate not clearly stated; industry-average ${headlineMonthlyPct}%/30 days used for the perceived-rate comparison.`);
  }

  const minDays = x.minimum_charge_days ?? 0;
  const floatDays = x.float_days ?? 0;
  // Honesty floor: only bill the face-basis uplift when the contract says face.
  const billOnFace = x.interest_base === 'full_invoice_face';
  if (x.interest_base === 'unclear') {
    assumptions.push('Fee base (invoice face vs amount advanced) unclear in the document; math assumes amount advanced, the cheaper reading.');
  }

  const interest = resolveInterestLeg(x, advanceRatePct, assumptions);
  const gf = auditConfig.goodFactor;

  const scenarios: ScenarioResult[] = auditConfig.scenarios.map((days) => {
    // Minimum-days charge first, then clearing-day float on top.
    const billedDays = Math.max(days, minDays) + floatDays;
    const commissionRaw = feePctForDays(x, billedDays) * (billOnFace ? 1 : advanceRatePct / 100);
    // NOTE on the line above: when the fee is charged on the advance, a schedule
    // quoted "on face" scales down by the advance rate; when charged on face it
    // does not. Schedules whose rates are already advance-based extract as such
    // in fee_schedule_verbatim and land in the same math via billOnFace=false.

    // Interest leg: simple interest on the basis for every billed day (the
    // float days are days the advance is still outstanding, so they count).
    const interestRaw = interest
      ? interest.basisPctOfFace * (interest.annualRatePct / 100) * (billedDays / interest.dayCount) * 100
      : 0;

    const feePctOfFace = round2(commissionRaw + interestRaw);
    const cashPctOfFace = advanceRatePct / 100;
    const aprOnFace = round1((feePctOfFace / days) * 365);
    const aprOnCash = round1((feePctOfFace / 100 / cashPctOfFace / days) * 365 * 100);

    // Better-contract standard: daily rate, interest on advance only, no minimums,
    // no float. Plus the two 2026-08-05 levers, modeled conservatively: the client
    // schedules the draw later than invoicing (the meter runs a fraction of the
    // invoice-to-payment window) and draws only part of the eligible advance.
    const gfDailyPct = (gf.monthlyEquivalentPct * 12) / 365;
    const goodFactorCostPctOfFace = round2(
      gfDailyPct * (days * gf.scheduledDrawDayFraction) * (gf.advanceRatePct / 100) * gf.drawUtilization,
    );

    return {
      days,
      billedDays,
      commissionPctOfFace: round2(commissionRaw),
      interestPctOfFace: round2(interestRaw),
      feePctOfFace,
      aprOnFace,
      aprOnCash,
      monthlyEquivalentPctOnCash: round2(aprOnCash / 12),
      goodFactorCostPctOfFace,
    };
  });

  // Monthly minimum uplift: only computable (and only asserted) with real volume.
  let monthlyMinimumUpliftUsdPerYear: number | null = null;
  if (x.monthly_minimum.found === 'yes' && x.monthly_minimum.amount_usd && x.annual_volume_usd) {
    const monthlyVolume = x.annual_volume_usd / 12;
    const midScenario = scenarios[1] ?? scenarios[0];
    const impliedMonthlyFees = (monthlyVolume * midScenario.feePctOfFace) / 100;
    const shortfall = Math.max(0, x.monthly_minimum.amount_usd - impliedMonthlyFees);
    monthlyMinimumUpliftUsdPerYear = Math.round(shortfall * 12);
  }

  // ---- Savings (spec section 5): per-dollar delta x volume, computed from the
  // CONSERVATIVE end: the scenario where their contract looks BEST.
  const deltas = scenarios.map((s) => ({
    days: s.days,
    perYearPer100k: Math.max(0, ((s.feePctOfFace - s.goodFactorCostPctOfFace) / 100) * 100_000),
  }));
  const conservative = deltas.reduce((a, b) => (b.perYearPer100k < a.perYearPer100k ? b : a));

  const savings: SavingsResult = {
    perYearPer100kFace: Math.round(conservative.perYearPer100k),
    perYearAtVolume: x.annual_volume_usd
      ? Math.round((conservative.perYearPer100k * x.annual_volume_usd) / 100_000)
      : null,
    volumeUsd: x.annual_volume_usd,
    conservativeScenarioDays: conservative.days,
  };

  assumptions.push(
    `Better-terms comparison uses the conservative end of the better contract we place into: ${gf.monthlyEquivalentPct}% monthly equivalent charged as a daily rate on the amount advanced, no minimum-day charges, no clearing-day float.`,
  );
  assumptions.push(
    `Scheduled-advance and borrowing-base behavior modeled conservatively: the comparison assumes the meter runs ${Math.round(gf.scheduledDrawDayFraction * 100)}% of the invoice-to-payment window and ${Math.round(gf.drawUtilization * 100)}% of the eligible advance is drawn.`,
  );

  return {
    scenarios,
    perceived: {
      headlineMonthlyPct,
      headlineAssumed,
      aprSimple: round1(headlineMonthlyPct * 12),
    },
    advanceRatePct,
    advanceRateAssumed,
    interest,
    monthlyMinimumUpliftUsdPerYear,
    savings,
    assumptions,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
