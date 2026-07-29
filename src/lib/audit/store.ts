// Blob-backed job store. EVERY file is created exactly once and never
// overwritten, so status checks are authenticated head() calls and content
// fetches never race a CDN-cached stale version:
//   jobs/{id}/job.json      created at submit (lead + consent + file list)
//   jobs/{id}/s1.json..s4   stage markers written as the pipeline advances
//   jobs/{id}/internal.json full internal report (factor name lives HERE only)
//   jobs/{id}/report.json   visitor-safe report; its existence = job done
//   ratelimit/{iphash}-{ts}.json  one marker per submission for the IP throttle
import { put, head, list, del } from '@vercel/blob';
import { createHash } from 'node:crypto';
import { auditConfig } from '../../config/audit';
import type { VisitorReport, InternalReport } from './report';

export type AuditStage = 'reading_contract' | 'extracting_terms' | 'computing_rates' | 'building_report';

const STAGE_FILES: Record<number, AuditStage> = {
  1: 'reading_contract',
  2: 'extracting_terms',
  3: 'computing_rates',
  4: 'building_report',
};

export interface JobFile {
  url: string;
  pathname: string;
  contentType: string;
}

export interface ConsentRecord {
  text: string; // verbatim text the visitor agreed to
  clientTimestamp: string;
  url: string;
  ip: string;
  userAgent: string;
  receivedAt: string;
}

export interface JobRecord {
  id: string;
  createdAt: string;
  lead: { name: string; email: string; phone: string };
  files: JobFile[];
  consent: ConsentRecord;
}

const JSON_PUT_OPTS = {
  access: 'public' as const,
  addRandomSuffix: false,
  contentType: 'application/json',
  cacheControlMaxAge: 60,
};

const jobPath = (id: string, file: string) => `jobs/${id}/${file}`;

async function exists(pathname: string): Promise<{ ok: boolean; url?: string }> {
  try {
    const meta = await head(pathname);
    return { ok: true, url: meta.url };
  } catch {
    return { ok: false };
  }
}

export async function createJob(job: JobRecord): Promise<void> {
  await put(jobPath(job.id, 'job.json'), JSON.stringify(job), JSON_PUT_OPTS);
}

export async function readJob(id: string): Promise<JobRecord | null> {
  const meta = await exists(jobPath(id, 'job.json'));
  if (!meta.ok || !meta.url) return null;
  const res = await fetch(meta.url);
  if (!res.ok) return null;
  return (await res.json()) as JobRecord;
}

export async function markStage(id: string, stage: 1 | 2 | 3 | 4): Promise<void> {
  // Created-once marker; if a retry re-marks a stage the put would overwrite an
  // identical empty object, so guard with a head check to keep the invariant.
  const path = jobPath(id, `s${stage}.json`);
  const already = await exists(path);
  if (!already.ok) await put(path, '{}', JSON_PUT_OPTS);
}

export async function writeReports(id: string, internal: InternalReport, visitor: VisitorReport): Promise<void> {
  await put(jobPath(id, 'internal.json'), JSON.stringify(internal), JSON_PUT_OPTS);
  // report.json LAST: its existence is the done signal.
  await put(jobPath(id, 'report.json'), JSON.stringify(visitor), JSON_PUT_OPTS);
}

export async function writeVisitorReportOnly(id: string, visitor: VisitorReport): Promise<void> {
  await put(jobPath(id, 'report.json'), JSON.stringify(visitor), JSON_PUT_OPTS);
}

export type JobStatus =
  | { state: 'unknown' }
  | { state: 'processing'; stage: AuditStage }
  | { state: 'done'; report: VisitorReport };

export async function getJobStatus(id: string): Promise<JobStatus> {
  const report = await exists(jobPath(id, 'report.json'));
  if (report.ok && report.url) {
    const res = await fetch(report.url);
    if (res.ok) return { state: 'done', report: (await res.json()) as VisitorReport };
  }
  // Highest stage marker wins; check in parallel.
  const [s4, s3, s2, s1, job] = await Promise.all([
    exists(jobPath(id, 's4.json')),
    exists(jobPath(id, 's3.json')),
    exists(jobPath(id, 's2.json')),
    exists(jobPath(id, 's1.json')),
    exists(jobPath(id, 'job.json')),
  ]);
  if (s4.ok) return { state: 'processing', stage: STAGE_FILES[4] };
  if (s3.ok) return { state: 'processing', stage: STAGE_FILES[3] };
  if (s2.ok) return { state: 'processing', stage: STAGE_FILES[2] };
  if (s1.ok) return { state: 'processing', stage: STAGE_FILES[1] };
  if (job.ok) return { state: 'processing', stage: STAGE_FILES[1] };
  return { state: 'unknown' };
}

// ---- IP rate limit: created-once markers + list-count ----

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

/** True = allowed (marker stamped). False = over the hourly cap. */
export async function checkAndStampRateLimit(ip: string): Promise<boolean> {
  const iphash = hashIp(ip);
  const prefix = `ratelimit/${iphash}-`;
  const { blobs } = await list({ prefix, limit: 100 });
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = blobs.filter((b) => {
    const ts = Number(b.pathname.slice(prefix.length).replace('.json', ''));
    return Number.isFinite(ts) && ts > hourAgo;
  });
  if (recent.length >= auditConfig.maxSubmissionsPerIpPerHour) return false;
  await put(`${prefix}${Date.now()}.json`, '{}', JSON_PUT_OPTS);
  return true;
}

// ---- Retention cleanup (cron) ----

export async function cleanupExpired(): Promise<{ deleted: number }> {
  const cutoff = Date.now() - auditConfig.retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const prefix of ['contracts/', 'jobs/', 'ratelimit/']) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      const stale = page.blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff);
      if (stale.length > 0) {
        await del(stale.map((b) => b.url));
        deleted += stale.length;
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return { deleted };
}
