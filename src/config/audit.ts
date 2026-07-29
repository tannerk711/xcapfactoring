// ============================================================================
// AUDIT TOOL CONFIG. This is the ONE file the Przemek tuning session edits.
// Everything marked TODO-PRZEMEK-RATE-SHEET is a conservative placeholder that
// stands in for the good factor's real rate sheet until he provides it.
// ============================================================================

export const auditConfig = {
  // ---- The good factor's terms (PLACEHOLDERS: conservative end of what Przemek
  // described on the close call: "1 to 1.5%, charged as a daily rate, interest on
  // the amount advanced only"). Using the EXPENSIVE end (1.5) so every savings
  // number is a floor, never a walk-back.
  goodFactor: {
    // TODO-PRZEMEK-RATE-SHEET: replace with the real rate card per volume tier.
    monthlyEquivalentPct: 1.5, // conservative end of the 1 to 1.5 range
    interestBasis: 'advance' as const, // interest only on the amount advanced
    advanceRatePct: 90, // TODO-PRZEMEK-RATE-SHEET: confirm typical advance
    minimumChargeDays: 0, // daily rate, no phantom interest
    floatDays: 0, // TODO-PRZEMEK-RATE-SHEET: confirm clearing-day policy
  },

  // ---- Verdict threshold: below this true monthly-equivalent cost (on cash
  // received) with no critical lock-in flags, the honest answer is "your
  // contract is competitive." TODO-PRZEMEK-RATE-SHEET: tune in the test session.
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
