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
import { normalizeAttribution } from '../../../lib/attribution';

export const prerender = false;

const BLOB_HOST_RE = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//;

const SubmitSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(7).max(30),
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
  // Optional ad-click attribution (gclid, utm_*, ValueTrack). Organic leads
  // send empty values or nothing at all; normalizeAttribution fills the shape.
  attribution: z
    .object({
      params: z.record(z.string(), z.string().max(200)).optional(),
      landingPage: z.string().max(500).optional(),
      referrer: z.string().max(500).optional(),
      firstSeenAt: z.string().max(64).optional(),
    })
    .optional(),
});

// Seconds from first interaction to submit, sent by the client. Anything else is "unknown".
const secondsOf = (v: unknown) => Number(v);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(400, { error: 'invalid request body' });
  }

  // Honeypot is a LABEL, never a gate (Tanner, 2026-10-06: every complete
  // submit fires the Zap and becomes a lead). A filled trap travels as
  // honeypotFilled: true on the payload and gets one log line; nothing is
  // dropped. The pre-rename trap key is still read for cached bundles.
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const who = () =>
    JSON.stringify({
      name: typeof body.name === 'string' ? body.name : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
    });
  const trap = [body.ff_hp, body.company].find((v) => typeof v === 'string' && v.trim() !== '');
  delete body.ff_hp;
  delete body.company;
  const seconds = secondsOf(body.secondsToComplete);
  const honeypotFilled = trap !== undefined;
  if (honeypotFilled) {
    console.warn(`[audit] trap filled (${seconds}s), forwarding flagged`, who());
  }

  const parsed = SubmitSchema.safeParse(body);
  if (!parsed.success) {
    console.warn(`[audit] rejected: missing ${parsed.error.issues[0]?.path.join('.') || 'body'}`, who());
    return json(400, { error: 'validation failed', details: parsed.error.issues.map((i) => i.path.join('.')).slice(0, 5) });
  }
  const data = parsed.data;

  // Consent gate is server-side because this is a legal record; a client-only
  // gate is bypassable. 400 when consent is absent.
  if (data.consent.agreed !== true) {
    console.warn('[audit] rejected: missing consent', who());
    return json(400, { error: 'consent required' });
  }

  // One document (PDF/DOCX) or up to 30 photos; never a mix.
  const docCount = data.files.filter((f) => !f.contentType.startsWith('image/')).length;
  if (docCount > 1 || (docCount === 1 && data.files.length > 1)) {
    console.warn('[audit] rejected: invalid file mix', who());
    return json(400, { error: 'upload a single PDF or DOCX, or photos of the pages' });
  }
  if (docCount === 0 && data.files.length > 30) {
    console.warn('[audit] rejected: too many photos', who());
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
      console.warn('[audit] rejected: rate limited', who());
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
    attribution: normalizeAttribution(data.attribution),
    honeypotFilled,
  };

  // Lead first (standing rule: fires once, on submit, before analysis).
  const webhookOk = await fireLeadWebhook(job);

  try {
    await createJob(job);
  } catch (err) {
    console.error('[audit] job record write failed:', who(), err);
    return json(500, { error: 'We could not start the audit, but your details went through. Our analyst will review your contract personally.' });
  }

  // One line per accepted submission, so "did it reach the Zap" is a log search.
  console.log(
    `[audit] accepted, webhook ${webhookOk ? 'delivered' : 'FAILED'}`,
    JSON.stringify({
      name: data.name,
      email: data.email,
      receivedAt: job.consent.receivedAt,
      ip,
      seconds,
      honeypotFilled,
    }),
  );

  waitUntil(processAuditJob(job));

  return json(200, { jobId: job.id });
};
