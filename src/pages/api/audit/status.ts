// GET /api/audit/status?jobId= : polled every 2.5s by the processing screen.
// Authenticated head() checks against created-once blobs; nothing here ever
// fetches an overwritten URL because nothing is ever overwritten.
import type { APIRoute } from 'astro';
import { getJobStatus } from '../../../lib/audit/store';

export const prerender = false;

const ID_RE = /^[A-Za-z0-9_-]{21}$/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const GET: APIRoute = async ({ url }) => {
  const jobId = url.searchParams.get('jobId') ?? '';
  if (!ID_RE.test(jobId)) return json(400, { error: 'bad jobId' });

  try {
    const status = await getJobStatus(jobId);
    if (status.state === 'unknown') return json(404, { error: 'not found' });
    if (status.state === 'done') return json(200, { done: true, report: status.report });
    return json(200, { done: false, stage: status.stage });
  } catch (err) {
    console.error('[audit] status check failed:', err);
    return json(500, { error: 'status unavailable' });
  }
};
