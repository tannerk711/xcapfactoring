// Extraction schema, from specs/audit-tool-spec.md section 2. Every field is
// nullable with a found status; the report only asserts what was actually found.
// The model extracts; TypeScript computes (rate-math.ts).
import { z } from 'zod';

export const Found = z.enum(['yes', 'no', 'unclear']);

const nStr = z.union([z.string(), z.null()]);
const nNum = z.union([z.number(), z.null()]);

export const Tier = z.object({
  from_day: z.number(),
  to_day: nNum, // null = open-ended final tier
  rate_pct: z.number(), // percent of the fee base charged for this block
  block_days: nNum, // e.g. 10 for "+0.65% per 10 days"; null if the tier is a single span
});

export const ExtractionSchema = z.object({
  // ---- core economics
  advance_rate_pct: nNum,
  fee_structure_type: z.enum(['flat', 'tiered_by_days', 'admin_plus_interest', 'hybrid', 'other', 'unknown']),
  fee_schedule_verbatim: nStr,
  fee_tiers: z.union([z.array(Tier), z.null()]),
  flat_fee_pct: nNum,
  per_invoice_minimum_fee_usd: nNum,
  interest_base: z.enum(['full_invoice_face', 'amount_advanced', 'unclear']),
  minimum_charge_days: nNum,
  float_days: nNum,
  batch_billing: Found,
  monthly_minimum: z.object({
    found: Found,
    description: nStr,
    amount_usd: nNum,
    // 2026-08-05 (Darren): the flag is FORCED minimums. 'yes' only when a
    // shortfall penalty / true-up applies for missing the number.
    forced_with_penalty: Found,
  }),
  // 2026-08-05 additions: advance timing ("when the meter starts") + funding speed.
  advance_timing: z.object({
    found: Found,
    // 'no' = advance and fee accrual are forced at invoice purchase, no
    // draw-on-request mechanism. 'yes' = client schedules/requests draws.
    client_controls_timing: Found,
    description: nStr,
  }),
  funding_speed: z.object({
    found: Found,
    stated_timeline: nStr,
    business_days_min: nNum,
    same_day_available: Found,
    same_day_surcharge_usd: nNum,
  }),

  // ---- named junk fees (2026-08-05, Darren's list; also swept into ancillary_fees)
  monitoring_fee: z.object({ found: Found, amount_usd: nNum, quote: nStr }),
  wire_fee_usd: nNum,
  ach_fee_usd: nNum,
  new_debtor_credit_fee: z.object({ found: Found, amount_usd: nNum, quote: nStr }),
  due_diligence_fee: z.object({ found: Found, amount_usd: nNum, quote: nStr }),

  // ---- term and exit (weight heaviest for switchers)
  term_months: nNum,
  auto_renewal: z.object({
    found: Found,
    renewal_period_months: nNum,
    description: nStr,
  }),
  cancellation_window: z.object({
    found: Found,
    description: nStr,
    notice_days_min: nNum,
    notice_days_max: nNum,
    certified_mail_required: Found,
  }),
  early_termination_fee: z.object({
    found: Found,
    structure: z.enum(['flat', 'pct_of_line', 'months_remaining_formula', 'lookback', 'shortfall', 'other', 'none_found']),
    description: nStr,
    flat_amount_usd: nNum,
    pct_of_line: nNum,
  }),
  ucc_lien_scope: z.enum(['all_assets', 'accounts_receivable_only', 'none_found', 'unclear']),
  release_terms: z.object({
    found: Found,
    general_release_required: Found, // the 9-513 waiver / release-hostage pattern
    description: nStr,
  }),
  reserve_terms: z.object({
    found: Found,
    reserve_pct: nNum,
    withholding_rights_broad: Found,
    description: nStr,
  }),

  // ---- control and guarantee layer
  whole_ledger_required: Found,
  personal_guarantee: z.enum(['full_pg', 'validity_only', 'limited_pg', 'none_found', 'unclear']),
  confession_of_judgment: Found, // MAXIMAL severity if yes
  asymmetric_exit_rights: z.object({ found: Found, description: nStr }),
  cross_collateralization: Found,
  power_of_attorney: z.object({ found: Found, scope_broad: Found, description: nStr }),
  misdirected_payment_penalty: z.object({ found: Found, pct_of_face: nNum, description: nStr }),
  concentration_limit: z.object({ found: Found, description: nStr }),

  // ---- ancillary fee sweep
  ancillary_fees: z.array(
    z.object({
      name: z.string(),
      amount_usd: nNum,
      pct: nNum,
      unit: nStr, // e.g. "per transfer", "per invoice", "per month"
      quote: nStr,
    }),
  ),

  // ---- meta
  factor_name: nStr, // NEVER shown to visitors; internal + Przemek email only
  document_type: z.enum(['factoring_agreement', 'factoring_proposal', 'other_financing', 'not_financing', 'unreadable']),
  document_type_confidence_pct: z.number(),
  headline_rate_pct: nNum, // the rate the client would quote if asked ("i'm at 2.5")
  annual_volume_usd: nNum, // only if extractable (line size, stated volumes, minimums)
  notable_quotes: z.array(
    z.object({
      topic: z.string(),
      quote: z.string(),
      page: nNum,
    }),
  ),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
