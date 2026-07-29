// Daily retention cron (vercel.json): deletes contracts/, jobs/, ratelimit/
// blobs older than auditConfig.retentionDays. Bearer-authed with CRON_SECRET.
import type { APIRoute } from 'astro';
import { cleanupExpired } from '../../../lib/audit/store';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  try {
    const { deleted } = await cleanupExpired();
    return new Response(JSON.stringify({ ok: true, deleted }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[audit] cleanup failed:', err);
    return new Response(JSON.stringify({ error: 'cleanup failed' }), { status: 500 });
  }
};
