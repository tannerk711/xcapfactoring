# xcapfactoring.com

Astro 5 + React islands + Tailwind v4 on Vercel. Static output; `/api/*` routes are serverless
(`prerender = false`, `maxDuration: 300`). The hero mechanism is the factoring contract audit tool
(spec: `../specs/audit-tool-spec.md`).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 4321 |
| `npm run build` | Production build (zero errors is the bar) |
| `npm run test:math` | Deterministic rate-math tests against published APR anchors |
| `npm run test:extraction` | Live extraction test on the SEC-filed Bay View specimen (needs `ANTHROPIC_API_KEY`) |

## Environment variables

All server-side only. Copy `.env.example` to `.env` for local work; set the same names in the
Vercel project for production.

| Name | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Contract extraction call (`claude-opus-5`, structured outputs) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store (uploads, job store, reports). Auto-injected on Vercel when a Blob store is attached |
| `LEAD_WEBHOOK_URL` | **Zapier catch hook** (never a GHL inbound webhook). One POST per lead, on submit, with the full TCPA consent record |
| `AUDIT_NOTIFY_WEBHOOK_URL` | **Zapier catch hook** (never a GHL inbound webhook). Completion payload for Przemek: terms table, all flags, factor name, contract link, manual-review flag. If unset, sends are skipped and logged |
| `CRON_SECRET` | Bearer auth for `/api/cron/cleanup` (daily retention sweep, `vercel.json` cron) |
| `RETENTION_DAYS` | Optional override of the 90-day contract retention window |

## Deploy (first time)

1. `vercel project ls` FIRST. Standing rule: linking with a guessed name silently creates a
   duplicate project and env vars land somewhere the real site never reads.
2. If no project exists yet: `vercel link` and create `xcapfactoring` (confirm the name with Tanner).
3. Attach a Blob store to the project (Vercel dashboard, Storage tab). This injects
   `BLOB_READ_WRITE_TOKEN` automatically.
4. Add the remaining env vars (`ANTHROPIC_API_KEY`, `LEAD_WEBHOOK_URL`, `AUDIT_NOTIFY_WEBHOOK_URL`,
   `CRON_SECRET`) as server-side env vars.
5. `vercel deploy --prod`. The `vercel.json` cron (daily cleanup at 08:00 UTC) registers on deploy.
6. DNS: apex canonical + www 308 redirect, per the dscrbroker pattern. Przemek owns the domain.

## Audit tool architecture (short version)

- Browser sniffs magic bytes, uploads client-direct to Vercel Blob (`/api/audit/upload` issues the
  token), so the 4.5MB serverless body cap never touches contract files.
- `POST /api/audit`: zod validation, honeypot, server-side consent gate (400 without it), per-IP
  throttle (4/hr via created-once `ratelimit/` blobs), lead webhook fires immediately, job record
  written, pipeline kicked via `waitUntil`, `jobId` returned.
- Pipeline (`src/lib/audit/extract.ts`): re-sniff server-side, DOCX text via mammoth,
  `claude-opus-5` extraction via `client.messages.parse` + `zodOutputFormat` (PDF as a base64
  document block, effort medium, no thinking param), deterministic TypeScript rate math, report
  build. Retries once on API error; every failure lands on a manual-review report. The lead is
  never lost.
- Job store: created-once blobs under `jobs/{id}/` (`job.json`, `s1..s4.json` stage markers,
  `internal.json`, `report.json`). `GET /api/audit/status` does authenticated `head()` checks;
  nothing is ever overwritten, so no stale-CDN reads.
- The incumbent factor's name lives in `internal.json` and the Przemek webhook ONLY. It never
  enters `report.json` or any visitor-facing output.
- Retention: daily cron deletes `contracts/`, `jobs/`, `ratelimit/` blobs older than
  `RETENTION_DAYS` (default 90).

## Tuning session (Przemek)

Every number a tuning session should touch lives in ONE file: `src/config/audit.ts`
(`TODO-PRZEMEK-RATE-SHEET` markers). Test protocol in `../specs/audit-tool-spec.md` section 5;
log every run in `../testing/audit-tool-tests.md`.
