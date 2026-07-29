// Outbound webhooks. Both URLs are Zapier catch hooks that Tanner maps into
// GoHighLevel himself (standing rule: never GHL inbound webhooks). One lead
// webhook per submission, fired immediately on submit, no partial captures.
// If a URL is unset the send is skipped and logged; the pipeline never fails
// because of a webhook.
import type { JobRecord } from './store';
import type { InternalReport, RedFlag } from './report';
import type { Extraction } from './schema';

async function post(url: string, payload: unknown): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
    } catch {
      // fall through to retry
    }
  }
  return false;
}

/** Fired ONCE per lead, on submit, before any analysis. Full TCPA consent record. */
export async function fireLeadWebhook(job: JobRecord): Promise<void> {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) {
    console.warn('[audit] LEAD_WEBHOOK_URL not set; lead webhook skipped for job', job.id);
    return;
  }
  await post(url, {
    source: 'xcapfactoring.com audit tool',
    jobId: job.id,
    name: job.lead.name,
    email: job.lead.email,
    phone: job.lead.phone,
    submittedAt: job.createdAt,
    consent: {
      agreed: true,
      text: job.consent.text, // verbatim; map to a Multi Line field in GHL or it truncates
      clientTimestamp: job.consent.clientTimestamp,
      url: job.consent.url,
      ip: job.consent.ip,
      userAgent: job.consent.userAgent,
      receivedAt: job.consent.receivedAt,
    },
  });
}

function termRow(field: string, value: string | number | null | undefined, found?: string): { field: string; value: string; found: string } {
  return {
    field,
    value: value === null || value === undefined || value === '' ? 'not found' : String(value),
    found: found ?? (value === null || value === undefined ? 'no' : 'yes'),
  };
}

export function buildTermsTable(x: Extraction): { field: string; value: string; found: string }[] {
  return [
    termRow('Document type', `${x.document_type} (${x.document_type_confidence_pct}% confidence)`),
    termRow('Factor name', x.factor_name),
    termRow('Advance rate %', x.advance_rate_pct),
    termRow('Fee structure', x.fee_structure_type),
    termRow('Fee schedule (verbatim)', x.fee_schedule_verbatim),
    termRow('Flat fee %', x.flat_fee_pct),
    termRow('Headline rate %', x.headline_rate_pct),
    termRow('Interest base', x.interest_base),
    termRow('Minimum charge days', x.minimum_charge_days),
    termRow('Float days', x.float_days),
    termRow('Batch billing', x.batch_billing),
    termRow('Monthly minimum', x.monthly_minimum.description, x.monthly_minimum.found),
    termRow('Term (months)', x.term_months),
    termRow('Auto renewal', x.auto_renewal.description, x.auto_renewal.found),
    termRow('Cancellation window', x.cancellation_window.description, x.cancellation_window.found),
    termRow('Early termination fee', x.early_termination_fee.description, x.early_termination_fee.found),
    termRow('ETF structure', x.early_termination_fee.structure),
    termRow('UCC lien scope', x.ucc_lien_scope),
    termRow('General release required', x.release_terms.general_release_required),
    termRow('Reserve terms', x.reserve_terms.description, x.reserve_terms.found),
    termRow('Whole ledger required', x.whole_ledger_required),
    termRow('Personal guarantee', x.personal_guarantee),
    termRow('Confession of judgment', x.confession_of_judgment),
    termRow('Asymmetric exit rights', x.asymmetric_exit_rights.description, x.asymmetric_exit_rights.found),
    termRow('Cross-collateralization', x.cross_collateralization),
    termRow('Misdirected payment penalty %', x.misdirected_payment_penalty.pct_of_face, x.misdirected_payment_penalty.found),
    termRow('Concentration limit', x.concentration_limit.description, x.concentration_limit.found),
    termRow('Annual volume (USD)', x.annual_volume_usd),
    termRow(
      'Ancillary fees',
      x.ancillary_fees.length > 0
        ? x.ancillary_fees.map((f) => `${f.name}: ${f.amount_usd ? '$' + f.amount_usd : ''}${f.pct ? f.pct + '%' : ''} ${f.unit ?? ''}`.trim()).join('; ')
        : null,
    ),
  ];
}

export interface CompletionPayload {
  jobId: string;
  manualReview: boolean;
  manualReviewReason?: string;
  lead: { name: string; email: string; phone: string };
  factorName: string | null;
  contractLinks: string[];
  termsTable?: { field: string; value: string; found: string }[];
  flags?: { severity: string; title: string; plainEnglish: string; clauseQuote: string | null }[];
  savings?: { perYearPer100kFace: number; perYearAtVolume: number | null };
  verdict?: string;
  summaryText: string;
}

/** Przemek's completion notification: extracted terms + ALL flags + factor name + contract link. */
export async function fireCompletionWebhook(
  job: JobRecord,
  internal: InternalReport | null,
  opts: { manualReview: boolean; manualReviewReason?: string },
): Promise<void> {
  const url = process.env.AUDIT_NOTIFY_WEBHOOK_URL;
  if (!url) {
    console.warn('[audit] AUDIT_NOTIFY_WEBHOOK_URL not set; completion webhook skipped for job', job.id);
    return;
  }

  const flags: RedFlag[] = internal?.allFlags ?? [];
  const lines: string[] = [
    `Audit ${opts.manualReview ? 'NEEDS MANUAL REVIEW' : 'complete'} for ${job.lead.name} (${job.lead.email}, ${job.lead.phone})`,
  ];
  if (opts.manualReview && opts.manualReviewReason) lines.push(`Reason: ${opts.manualReviewReason}`);
  if (internal) {
    lines.push(`Factor: ${internal.extraction.factor_name ?? 'not found'}`);
    if (internal.math) {
      const typical = internal.math.scenarios.find((s) => s.days === 45) ?? internal.math.scenarios[0];
      lines.push(
        `Effective APR on cash at 45 days: ${typical.aprOnCash}% (fee ${typical.feePctOfFace}% of face). Perceived: ${internal.math.perceived.aprSimple}%.`,
      );
      lines.push(
        `Conservative savings: $${internal.math.savings.perYearPer100kFace}/yr per $100K` +
          (internal.math.savings.perYearAtVolume ? `; $${internal.math.savings.perYearAtVolume}/yr at extracted volume` : ''),
      );
    }
    lines.push(`Flags (${flags.length}): ${flags.map((f) => `[${f.severity}] ${f.title}`).join(' | ') || 'none'}`);
    lines.push(`Visitor verdict: ${internal.visitor.verdict?.line ?? 'n/a (' + internal.visitor.status + ')'}`);
  }
  lines.push(`Contract file(s): ${job.files.map((f) => f.url).join(' ')}`);

  const payload: CompletionPayload = {
    jobId: job.id,
    manualReview: opts.manualReview,
    manualReviewReason: opts.manualReviewReason,
    lead: job.lead,
    factorName: internal?.extraction.factor_name ?? null,
    contractLinks: job.files.map((f) => f.url),
    termsTable: internal ? buildTermsTable(internal.extraction) : undefined,
    flags: flags.map((f) => ({
      severity: f.severity,
      title: f.title,
      plainEnglish: f.plainEnglish,
      clauseQuote: f.clauseQuote,
    })),
    savings: internal?.math
      ? {
          perYearPer100kFace: internal.math.savings.perYearPer100kFace,
          perYearAtVolume: internal.math.savings.perYearAtVolume,
        }
      : undefined,
    verdict: internal?.visitor.verdict?.line,
    summaryText: lines.join('\n'),
  };
  await post(url, payload);
}
