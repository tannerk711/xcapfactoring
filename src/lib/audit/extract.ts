// The extraction call + the background pipeline. The model extracts terms
// (claude-opus-5, structured outputs via messages.parse + zodOutputFormat);
// TypeScript computes every number the visitor sees (rate-math.ts).
// Locked call shape: thinking is on by default on claude-opus-5 so NO thinking
// param; output_config carries effort medium + the zod format; the PDF goes in
// as a base64 document block BEFORE the text block; stop_reason refusal and
// max_tokens are handled before content is read.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import mammoth from 'mammoth';
import { Buffer } from 'node:buffer';
import { ExtractionSchema, type Extraction } from './schema';
import { buildReport, buildManualReviewReport } from './report';
import { auditConfig } from '../../config/audit';
import { sniffBytes, isPhoto } from './sniff';
import { markStage, writeReports, writeVisitorReportOnly, type JobRecord } from './store';
import { fireCompletionWebhook } from './webhooks';

const EXTRACTION_SYSTEM = `You are a commercial-finance analyst extracting the terms of invoice factoring agreements for an audit tool. You are given the full document (PDF pages, photos of pages, or extracted text) and must fill the extraction schema.

Rules:
- Extract only what the document actually says. Never infer a number that is not stated. If a field is absent, use null and the appropriate "no"/"unclear"/"none_found" status.
- Rates: record percentages as numbers (2.5 for 2.5%). For tiered/block schedules, fill fee_tiers precisely: from_day, to_day (null if open-ended), rate_pct, and block_days for repeating blocks (e.g. "+0.65% per 10 days" is block_days 10). Also copy the schedule verbatim into fee_schedule_verbatim.
- interest_base: "full_invoice_face" only if fees are computed on the invoice face amount; "amount_advanced" if on the advance; "unclear" otherwise.
- headline_rate_pct is the single rate the client would quote if asked what they pay (usually the first-tier or advertised rate).
- annual_volume_usd only if derivable from stated volumes, line size, or minimums; otherwise null.
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

async function extractOnce(blocks: ContentBlock[]): Promise<Extraction> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.parse({
    model: auditConfig.model,
    max_tokens: auditConfig.extractionMaxTokens,
    system: EXTRACTION_SYSTEM,
    output_config: {
      effort: auditConfig.extractionEffort,
      format: zodOutputFormat(ExtractionSchema),
    },
    // Document/image blocks first, text instruction last (locked decision).
    messages: [{ role: 'user', content: [...blocks, { type: 'text', text: EXTRACTION_INSTRUCTION }] }],
  });

  if (response.stop_reason === 'refusal') {
    throw new ExtractionFailure('refusal', 'model declined the request');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ExtractionFailure('max_tokens', 'extraction truncated at max_tokens');
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new ExtractionFailure('no_output', 'no parsed output in response');
  return parsed;
}

/** Extraction with one retry on API error or refusal (spec section 4). */
export async function extractTerms(blocks: ContentBlock[]): Promise<Extraction> {
  try {
    return await extractOnce(blocks);
  } catch (err) {
    if (err instanceof ExtractionFailure && err.reason === 'unreadable_file') throw err;
    console.warn('[audit] extraction attempt 1 failed, retrying once:', err);
    return await extractOnce(blocks);
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
    await writeReports(job.id, internal, internal.visitor);
    await fireCompletionWebhook(job, internal, { manualReview: false });
  } catch (err) {
    const reason =
      err instanceof ExtractionFailure ? `${err.reason}: ${err.message}` : err instanceof Error ? err.message : 'unknown error';
    console.error('[audit] pipeline failed for job', job.id, reason);
    try {
      if (err instanceof ExtractionFailure && err.reason === 'unreadable_file') {
        // Honest unreadable state: ask for a re-upload, keep the lead.
        const visitor = buildManualReviewReport();
        visitor.status = 'unreadable';
        await writeVisitorReportOnly(job.id, visitor);
      } else {
        await writeVisitorReportOnly(job.id, buildManualReviewReport());
      }
      await fireCompletionWebhook(job, null, { manualReview: true, manualReviewReason: reason });
    } catch (inner) {
      console.error('[audit] failure-path write also failed for job', job.id, inner);
    }
  }
}
