// POST /api/audit: validate, honeypot, server-side consent gate, IP throttle,
// fire the lead webhook IMMEDIATELY, write the job record, kick processing via
// waitUntil, return jobId fast. The lead is captured before any analysis runs.
import type { APIRoute } from 'astro';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { createJob, checkAndStampRateLimit, type JobRecord } from '../../../lib/audit/store';
import { fireLeadWebhook } from '../../../lib/audit/webhooks';
import { processAuditJob } from '../../../lib/audit/extract';

export const prerender = false;

const BLOB_HOST_RE = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//;

const SubmitSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(7).max(30),
  company: z.string().optional().default(''), // honeypot; humans never see it
  files: z
    .array(
      z.object({
        url: z.string().url().regex(BLOB_HOST_RE, 'file must be an uploaded blob'),
        pathname: z.string().startsWith('contracts/'),
        contentType: z.string().max(120),
      }),
    )
    .min(1)
    .max(31),
  consent: z.object({
    agreed: z.boolean(),
    text: z.string().min(20).max(2000),
    clientTimestamp: z.string().max(64),
    url: z.string().max(500),
  }),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(400, { error: 'invalid request body' });
  }

  const parsed = SubmitSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { error: 'validation failed', details: parsed.error.issues.map((i) => i.path.join('.')).slice(0, 5) });
  }
  const data = parsed.data;

  // Honeypot: bots that fill the hidden field get a plausible response and no job.
  if (data.company && data.company.trim().length > 0) {
    return json(200, { jobId: nanoid(21) });
  }

  // Consent gate is server-side because this is a legal record; a client-only
  // gate is bypassable. 400 when consent is absent.
  if (data.consent.agreed !== true) {
    return json(400, { error: 'consent required' });
  }

  // One document (PDF/DOCX) or up to 30 photos; never a mix.
  const docCount = data.files.filter((f) => !f.contentType.startsWith('image/')).length;
  if (docCount > 1 || (docCount === 1 && data.files.length > 1)) {
    return json(400, { error: 'upload a single PDF or DOCX, or photos of the pages' });
  }
  if (docCount === 0 && data.files.length > 30) {
    return json(400, { error: 'up to 30 photos' });
  }

  let ip = 'unknown';
  try {
    ip = clientAddress;
  } catch {
    ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  }

  try {
    const allowed = await checkAndStampRateLimit(ip);
    if (!allowed) {
      return json(429, { error: 'Too many audits from this connection. Try again in an hour.' });
    }
  } catch (err) {
    // A throttle-store hiccup must not lose a real lead; log and continue.
    console.error('[audit] rate-limit check failed, allowing request:', err);
  }

  const job: JobRecord = {
    id: nanoid(21),
    createdAt: new Date().toISOString(),
    lead: { name: data.name, email: data.email, phone: data.phone },
    files: data.files.map((f) => ({ url: f.url, pathname: f.pathname, contentType: f.contentType })),
    consent: {
      text: data.consent.text,
      clientTimestamp: data.consent.clientTimestamp,
      url: data.consent.url,
      ip,
      userAgent: request.headers.get('user-agent') ?? '',
      receivedAt: new Date().toISOString(),
    },
  };

  // Lead first (standing rule: fires once, on submit, before analysis).
  await fireLeadWebhook(job);

  try {
    await createJob(job);
  } catch (err) {
    console.error('[audit] job record write failed:', err);
    return json(500, { error: 'We could not start the audit, but your details went through. Our analyst will review your contract personally.' });
  }

  waitUntil(processAuditJob(job));

  return json(200, { jobId: job.id });
};
