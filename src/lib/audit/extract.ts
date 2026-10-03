// The extraction call + the background pipeline. The model extracts terms
// (claude-opus-5); TypeScript computes every number the visitor sees
// (rate-math.ts). The full extraction schema exceeds the API's structured-output
// grammar budget ("compiled grammar is too large", verified 2026-08-20 in every
// arrangement), so the schema is enforced LOCALLY: the JSON Schema goes in the
// prompt, the response is validated with ExtractionSchema.safeParse, and one
// repair retry feeds the validation errors back. Locked call shape: thinking is
// on by default on claude-opus-5 so NO thinking param; output_config carries
// effort medium; the PDF goes in as a base64 document block BEFORE the text
// block; stop_reason refusal and max_tokens are handled before content is read.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import mammoth from 'mammoth';
import { Buffer } from 'node:buffer';
import { ExtractionSchema, type Extraction } from './schema';
import { buildReport, buildManualReviewReport } from './report';
import { auditConfig } from '../../config/audit';
import { sniffBytes, isPhoto } from './sniff';
import { markStage, writeInternalReport, writeVisitorReportOnly, type JobRecord } from './store';
import { fireCompletionWebhook } from './webhooks';

const EXTRACTION_SYSTEM = `You are a commercial-finance analyst extracting the terms of invoice factoring agreements for an audit tool. You are given the full document (PDF pages, photos of pages, or extracted text) and must fill the extraction schema.

Rules:
- Extract only what the document actually says. Never infer a number that is not stated. If a field is absent, use null and the appropriate "no"/"unclear"/"none_found" status.
- Rates: record percentages as numbers (2.5 for 2.5%). For tiered/block schedules, fill fee_tiers precisely: from_day, to_day (null if open-ended), rate_pct, and block_days for repeating blocks (e.g. "+0.65% per 10 days" is block_days 10). Also copy the schedule verbatim into fee_schedule_verbatim.
- interest_base is the base of the percentage FEE (discount fee, commission, factoring fee): "full_invoice_face" if that fee is computed on the gross / face amount of the invoice; "amount_advanced" if on the advance; "unclear" otherwise. It is NOT about interest on advances, which has its own field.
- Commission + interest contracts ("discount factoring", "old-line factoring"): when the agreement charges BOTH a commission or discount on the gross receivables AND interest on advances or outstanding balances (e.g. "a commission of 1% of the gross amount" plus "interest at 2% in excess of the prime rate on all sums advanced"), set fee_structure_type "admin_plus_interest", put the commission in flat_fee_pct (or fee_tiers if it escalates with selling terms) with interest_base "full_invoice_face" when it is on the gross amount, and fill interest_charge with found "yes": annual_rate_pct only when a fixed annual number is stated; index "prime" with spread_pct for "prime + 2%"; floor_annual_pct when a minimum rate is stated ("in no event less than 6% per annum" is 6); day_count 360 or 365 when stated; basis "amount_advanced" when charged on sums advanced; description verbatim. Contracts with no interest leg: interest_charge.found "no", index "none".
- headline_rate_pct is the single rate the client would quote if asked what they pay (usually the first-tier or advertised rate). For commission + interest contracts it is the commission rate, not the interest rate.
- A fee stated as $0.00 or "no charge" is not a fee: record found "no" for it.
- annual_volume_usd only if derivable from stated volumes, line size, or minimums; otherwise null.
- monthly_minimum.forced_with_penalty: "yes" only when a shortfall penalty, true-up, or minimum-fee obligation applies for missing the minimum; "no" when a minimum exists without penalty; "unclear" otherwise.
- advance_timing.client_controls_timing: "yes" only if the client may request or schedule advances at times of their choosing (draw-on-request or borrowing-base language); "no" if the agreement forces purchase/advance (and fee accrual) upon invoice submission with no request mechanism; "unclear" otherwise.
- funding_speed: the stated timeline between advance request (or invoice purchase) and disbursement of funds. Fill business_days_min as a number when stated ("within two business days" is 2; "same day" is 0). Record same-day availability and any same-day surcharge.
- Named fees, fill the dedicated fields AND include each in ancillary_fees: monitoring_fee (any recurring monthly monitoring/service/administration line item), wire_fee_usd and ach_fee_usd (per-transfer charges), new_debtor_credit_fee (credit-check or setup charge for onboarding a new customer/account debtor), due_diligence_fee (application, due diligence, or underwriting charges).
- notable_quotes: verbatim clause text (with page number when identifiable) supporting each significant finding, especially termination, renewal, release, and guarantee clauses.
- document_type: classify honestly. If this is not a factoring agreement or proposal, say so. If the document is illegible or truncated beyond usable, use "unreadable".
- factor_name: the factoring company that is party to the agreement, if named.`;

const EXTRACTION_INSTRUCTION =
  'Extract the factoring agreement terms from the attached document into the schema. Be precise with every number and quote clauses verbatim where the schema asks for descriptions or quotes.';

export class ExtractionFailure extends Error {
  constructor(
    public reason: 'refusal' | 'max_tokens' | 'no_output' | 'api_error' | 'unreadable_file',
    message: string,
  ) {
    super(message);
  }
}

type ContentBlock = Anthropic.ContentBlockParam;

/** Fetch each uploaded blob, re-sniff server-side, build model content blocks. */
export async function buildContentBlocks(files: { url: string }[]): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  let photoCount = 0;

  for (const file of files) {
    const res = await fetch(file.url);
    if (!res.ok) throw new ExtractionFailure('unreadable_file', `blob fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > auditConfig.maxFileBytes) {
      throw new ExtractionFailure('unreadable_file', 'file exceeds size ceiling');
    }
    const kind = sniffBytes(new Uint8Array(buf.subarray(0, 16)));

    if (kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
      });
    } else if (kind === 'docx') {
      let text = '';
      try {
        const result = await mammoth.extractRawText({ buffer: buf });
        text = result.value?.trim() ?? '';
      } catch {
        throw new ExtractionFailure('unreadable_file', 'docx could not be converted');
      }
      if (text.length < 50) throw new ExtractionFailure('unreadable_file', 'docx produced no usable text');
      blocks.push({
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: text },
      });
    } else if (isPhoto(kind)) {
      photoCount += 1;
      if (photoCount > auditConfig.maxPhotoFiles) throw new ExtractionFailure('unreadable_file', 'too many photos');
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: kind === 'jpeg' ? 'image/jpeg' : 'image/png',
          data: buf.toString('base64'),
        },
      });
    } else {
      // Server-side re-sniff caught a spoofed extension/content type.
      throw new ExtractionFailure('unreadable_file', 'unrecognized file bytes');
    }
  }

  if (blocks.length === 0) throw new ExtractionFailure('unreadable_file', 'no readable files');
  return blocks;
}

// The wire JSON Schema, generated from the same zod schema that validates the
// response, so prompt and validator can never drift.
const EXTRACTION_JSON_SCHEMA = JSON.stringify(zodOutputFormat(ExtractionSchema).schema);

/** Pull the JSON object out of the response text (tolerates fences/preamble). */
function parseExtractionText(text: string): Extraction {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new ExtractionFailure('no_output', 'no JSON object in response text');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new ExtractionFailure('no_output', `response is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const result = ExtractionSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 12)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ExtractionFailure('no_output', `schema validation failed: ${issues}`);
  }
  return result.data;
}

async function extractOnce(blocks: ContentBlock[], repairHint?: string): Promise<Extraction> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const instruction =
    `${EXTRACTION_INSTRUCTION}\n\nRespond with ONLY a single JSON object (no code fences, no commentary) that conforms exactly to this JSON Schema, with every property present:\n${EXTRACTION_JSON_SCHEMA}` +
    (repairHint ? `\n\nYour previous attempt failed validation. Fix these issues and emit the corrected complete object: ${repairHint}` : '');
  const response = await client.messages.create({
    model: auditConfig.model,
    max_tokens: auditConfig.extractionMaxTokens,
    system: EXTRACTION_SYSTEM,
    output_config: { effort: auditConfig.extractionEffort },
    // Document/image blocks first, text instruction last (locked decision).
    messages: [{ role: 'user', content: [...blocks, { type: 'text', text: instruction }] }],
  });

  if (response.stop_reason === 'refusal') {
    throw new ExtractionFailure('refusal', 'model declined the request');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ExtractionFailure('max_tokens', 'extraction truncated at max_tokens');
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) throw new ExtractionFailure('no_output', 'no text output in response');
  return parseExtractionText(text);
}

/** Extraction with one retry on API error, refusal, or validation failure (spec section 4). */
export async function extractTerms(blocks: ContentBlock[]): Promise<Extraction> {
  try {
    return await extractOnce(blocks);
  } catch (err) {
    if (err instanceof ExtractionFailure && err.reason === 'unreadable_file') throw err;
    console.warn('[audit] extraction attempt 1 failed, retrying once:', err);
    const hint =
      err instanceof ExtractionFailure && err.reason === 'no_output' ? err.message : undefined;
    return await extractOnce(blocks, hint);
  }
}

/**
 * The full background pipeline, kicked off from POST /api/audit via waitUntil.
 * The lead webhook has ALREADY fired by the time this runs; every failure path
 * lands on a manual-review report + Przemek notification, never a lost lead.
 */
export async function processAuditJob(job: JobRecord): Promise<void> {
  try {
    await markStage(job.id, 1); // reading_contract
    const blocks = await buildContentBlocks(job.files);

    await markStage(job.id, 2); // extracting_terms
    const extraction = await extractTerms(blocks);

    await markStage(job.id, 3); // computing_rates
    const internal = buildReport(extraction);

    await markStage(job.id, 4); // building_report
    await writeInternalReport(job.id, internal);
    // Przemek's notification BEFORE report.json. report.json is the done signal:
    // the visitor stops polling the moment it exists, and a serverless container
    // with no request in flight can be frozen mid-webhook. 2026-10-02: the second
    // live audit produced a report and no notification, exactly that race.
    await fireCompletionWebhook(job, internal, { manualReview: false });
    await writeVisitorReportOnly(job.id, internal.visitor);
  } catch (err) {
    const reason =
      err instanceof ExtractionFailure ? `${err.reason}: ${err.message}` : err instanceof Error ? err.message : 'unknown error';
    console.error('[audit] pipeline failed for job', job.id, reason);
    try {
      // Same ordering rule: notify Przemek before the done signal is written.
      // fireCompletionWebhook never throws, so the visitor report always follows.
      await fireCompletionWebhook(job, null, { manualReview: true, manualReviewReason: reason });
      if (err instanceof ExtractionFailure && err.reason === 'unreadable_file') {
        // Honest unreadable state: ask for a re-upload, keep the lead.
        const visitor = buildManualReviewReport();
        visitor.status = 'unreadable';
        await writeVisitorReportOnly(job.id, visitor);
      } else {
        await writeVisitorReportOnly(job.id, buildManualReviewReport());
      }
    } catch (inner) {
      console.error('[audit] failure-path write also failed for job', job.id, inner);
    }
  }
}
