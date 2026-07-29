// Deterministic rate math. The model extracts terms; THIS file computes every
// number the visitor sees. Formula components sourced in
// context/modern-factoring-research.md section 7:
//   effective rate = (all fees) / (cash actually received) x (365 / days outstanding)
// stacking: tier/block escalation + interest base (face vs advance) + minimum-days
// charge + float days, with monthly minimums handled as an uplift when volume is known.
import type { Extraction } from './schema';
import { auditConfig } from '../../config/audit';

export interface ScenarioResult {
  days: number; // invoice pays on this day
  billedDays: number; // after minimum-days and float stacking
  feePctOfFace: number; // total fee charged, as % of invoice face
  aprOnFace: number; // annualized on face (the convention published rates use)
  aprOnCash: number; // annualized on cash actually received (the honest number)
  monthlyEquivalentPctOnCash: number;
  goodFactorCostPctOfFace: number; // same scenario at the good-factor standard
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

/** Fee % of face for a given number of billed days under the extracted schedule. */
export function feePctForDays(x: Extraction, billedDays: number): number {
  // Flat structure: one rate per invoice regardless of days (rare in the wild
  // but the trucking flat-fee products exist).
  if (x.fee_structure_type === 'flat' && x.flat_fee_pct != null) {
    return x.flat_fee_pct;
  }

  const tiers = x.fee_tiers ?? [];
  if (tiers.length === 0) {
    // No schedule extracted: fall back to headline rate prorated in 30-day blocks
    // (block accrual: partial blocks bill as full blocks, the documented doctrine).
    const monthly = x.headline_rate_pct ?? auditConfig.assumptions.headlineMonthlyPctWhenUnknown;
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
  const faceBasis = x.interest_base !== 'amount_advanced'; // 'unclear' treated as face? No: conservative = advance.
  // Honesty floor: only bill the face-basis uplift when the contract says face.
  const billOnFace = x.interest_base === 'full_invoice_face';
  if (x.interest_base === 'unclear') {
    assumptions.push('Fee base (invoice face vs amount advanced) unclear in the document; math assumes amount advanced, the cheaper reading.');
  }

  const gf = auditConfig.goodFactor;

  const scenarios: ScenarioResult[] = auditConfig.scenarios.map((days) => {
    // Minimum-days charge first, then clearing-day float on top.
    const billedDays = Math.max(days, minDays) + floatDays;
    const feePctOfFace = round2(feePctForDays(x, billedDays) * (billOnFace ? 1 : advanceRatePct / 100));
    // NOTE on the line above: when the fee is charged on the advance, a schedule
    // quoted "on face" scales down by the advance rate; when charged on face it
    // does not. Schedules whose rates are already advance-based extract as such
    // in fee_schedule_verbatim and land in the same math via billOnFace=false.

    const cashPctOfFace = advanceRatePct / 100;
    const aprOnFace = round1((feePctOfFace / days) * 365);
    const aprOnCash = round1((feePctOfFace / 100 / cashPctOfFace / days) * 365 * 100);

    // Good-factor standard: daily rate, interest on advance only, no minimums, no float.
    const gfDailyPct = (gf.monthlyEquivalentPct * 12) / 365;
    const goodFactorCostPctOfFace = round2(gfDailyPct * days * (gf.advanceRatePct / 100));

    return {
      days,
      billedDays,
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
    `Better-terms comparison uses the conservative end of the standard we place into: ${gf.monthlyEquivalentPct}% monthly equivalent charged as a daily rate on the amount advanced, no minimum-day charges, no clearing-day float.`,
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
    monthlyMinimumUpliftUsdPerYear,
    savings,
    assumptions,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
