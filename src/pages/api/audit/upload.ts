// Client-direct upload token route (@vercel/blob client upload flow).
// The browser asks here for a scoped token, then uploads straight to Blob,
// so the 4.5MB serverless body cap never touches contract files.
import type { APIRoute } from 'astro';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { ACCEPTED_CONTENT_TYPES } from '../../../lib/audit/sniff';
import { auditConfig } from '../../../config/audit';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith('contracts/')) {
          throw new Error('uploads must live under contracts/');
        }
        return {
          allowedContentTypes: ACCEPTED_CONTENT_TYPES,
          addRandomSuffix: true,
          maximumSizeInBytes: auditConfig.maxFileBytes,
        };
      },
      // Fires from Vercel Blob after the upload lands; nothing to do here,
      // the submit call carries the final URLs.
      onUploadCompleted: async () => {},
    });
    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'upload token error';
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
