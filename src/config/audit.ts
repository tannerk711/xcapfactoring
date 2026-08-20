// ============================================================================
// AUDIT TOOL CONFIG. This is the ONE file the Przemek/Darren tuning session
// edits. Rate-sheet basis (Tanner's call, 2026-08-18): Darren's verbal terms
// from the 2026-08-05 review call ARE the working rate sheet; he is the good
// factor's own operator (fact sheet: context/darren-call-2026-08-05.md).
// Items marked TUNE-AT-SESSION get validated in the 5-to-15-contract session.
// ============================================================================

export const auditConfig = {
  // ---- The good factor's terms, operator-confirmed by Darren 2026-08-05:
  // "we do it for one and a half percent," daily-equivalent, interest on the
  // amount advanced only, borrowing-base draws from 0 to 90% of included AR.
  // Using the EXPENSIVE end (1.5) so every savings number is a floor, never a
  // walk-back.
  goodFactor: {
    monthlyEquivalentPct: 1.5, // confirmed; volume-tier variations, if any, land at the session
    interestBasis: 'advance' as const, // interest only on the amount advanced
    advanceRatePct: 90, // borrowing-base max per Darren (draw 0-90% of included AR)
    minimumChargeDays: 0, // daily rate, no phantom interest
    floatDays: 0, // TUNE-AT-SESSION: clearing days not addressed verbally; same-day funding implies none
    // Better-contract behavior factors (TUNE-AT-SESSION). Conservative reads of
    // the two levers Darren says can cut client cost ~50% (aging the receivable
    // + partial draws); we model far milder so savings stay a floor.
    scheduledDrawDayFraction: 0.85, // the meter runs 85% of the invoice-to-payment window
    drawUtilization: 0.9, // fraction of the eligible advance actually drawn
  },

  // ---- Verdict threshold: below this true monthly-equivalent cost (on cash
  // received) with no critical lock-in flags, the honest answer is "your
  // contract is competitive." TUNE-AT-SESSION.
  competitiveMonthlyEquivalentPct: 1.5,

  // ---- Assumptions used when a field could not be extracted (always labeled
  // as assumptions in the report).
  assumptions: {
    advanceRatePctWhenUnknown: 88, // mid of the 85-90 typical range
    headlineMonthlyPctWhenUnknown: 2.5, // industry average headline (Corpay)
  },

  // ---- Payment-timing scenarios the math runs (days to invoice payment).
  scenarios: [30, 45, 60] as const,

  // ---- Savings display floor: if the conservative estimate lands under this,
  // the report does not lead with a dollar figure (avoids "$40/yr savings" noise).
  minSavingsToDisplayUsd: 500,

  // ---- Contract file retention (days). Spec default 90; confirm with Przemek.
  retentionDays: Number(process.env.RETENTION_DAYS ?? 90),

  // ---- Abuse guards
  maxSubmissionsPerIpPerHour: 4,
  maxFileBytes: 32 * 1024 * 1024, // Anthropic request ceiling
  maxPhotoFiles: 30,

  // ---- Extraction model call
  model: 'claude-opus-5',
  extractionEffort: 'medium' as const, // tune during the Przemek session
  extractionMaxTokens: 16000,
} as const;

export type AuditConfig = typeof auditConfig;
