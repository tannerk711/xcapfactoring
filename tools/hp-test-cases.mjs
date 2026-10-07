#!/usr/bin/env node
// XCap /api/audit honeypot contract test (7 cases), derived from the shared harness
// tools/hp-test.mjs at the workspace root. Run from THIS repo:
//   node tools/hp-test-cases.mjs [--port 4422] [--catcher 5422]
// Differences from the shared harness: the route stores jobs in Vercel Blob and
// throttles per IP through Blob, so a local stub (catcher port + 1) stands in
// for the Blob API (VERCEL_BLOB_API_URL, bogus token) and no real blob, job, or
// throttle marker is ever touched. The stub's empty list means the IP throttle
// never trips here; production code is unchanged. Case 7 differs by design: this
// route never fails the visitor on a dead webhook (the audit still runs), so it
// expects 200 plus the "lead webhook unreachable" log naming the lead.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, []),
);
const need = (k) => {
  if (!args[k] || args[k] === true) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
  return args[k];
};

const repo = resolve('.');
const payloadPath = resolve('tools/hp-payload.json');
const hpKey = 'ff_hp';
const oldKey = 'company';
const requiredField = 'email';
const route = '/api/audit';
const port = Number(args.port) || 4422;
const catcherPort = Number(args.catcher) || 5422;
const blobPort = catcherPort + 1;
const envKey = args['env-key'] && args['env-key'] !== true ? args['env-key'] : 'LEAD_WEBHOOK_URL';
const secondsKey = args['seconds-key'] && args['seconds-key'] !== true ? args['seconds-key'] : 'secondsToComplete';
const logPrefix = '[audit]';
const keep = Boolean(args.keep);

const basePayload = JSON.parse(readFileSync(payloadPath, 'utf8'));
const catcherUrl = `http://127.0.0.1:${catcherPort}/`;

// ---------- catcher ----------
let received = [];
let catcherStatus = 200;
const catcher = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = { _raw: body.slice(0, 200) }; }
    received.push(parsed);
    res.writeHead(catcherStatus, { 'Content-Type': 'application/json' });
    res.end(catcherStatus === 200 ? '{"status":"success"}' : '{"status":"error"}');
  });
});
await new Promise((r) => catcher.listen(catcherPort, '127.0.0.1', r));

// ---------- Blob API stub ----------
const blobStub = createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    blobCalls.push(req.method + ' ' + req.url.slice(0, 60)); if (process.env.HP_DEBUG) console.log('[stub]', req.method, req.url.slice(0, 120));
    res.writeHead(req.method === 'HEAD' || (req.method === 'GET' && !req.url.startsWith('/?')) ? 404 : 200, { 'Content-Type': 'application/json' });
    if (req.method === 'PUT') res.end(JSON.stringify({ url: 'http://127.0.0.1/x', downloadUrl: 'http://127.0.0.1/x', pathname: 'x', contentType: 'application/json', contentDisposition: 'inline' }));
    else if (req.method === 'GET' && req.url.startsWith('/?')) res.end(JSON.stringify({ blobs: [], hasMore: false }));
    else res.end('{}');
  });
});
const blobCalls = [];
await new Promise((r) => blobStub.listen(blobPort, '127.0.0.1', r));
const stubEnv = { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_hptest_hptest', VERCEL_BLOB_API_URL: `http://127.0.0.1:${blobPort}`, ANTHROPIC_API_KEY: 'hp-test-bogus' };

// Env goes through the spawned process only; no env file is read or written.
const restoreEnv = () => {};

// ---------- dev server ----------
const portFree = await new Promise((r) => {
  const s = net.createServer();
  s.once('error', () => r(false));
  s.once('listening', () => s.close(() => r(true)));
  s.listen(port, '127.0.0.1');
});
if (!portFree) {
  restoreEnv();
  catcher.close();
  console.error(`port ${port} is busy; pass --port with a free one (never kill a server you did not start)`);
  process.exit(2);
}

const logLines = [];
const dev = spawn('npx', ['astro', 'dev', '--port', String(port), '--host', '127.0.0.1'], {
  cwd: repo,
  shell: true,
  env: { ...process.env, ...stubEnv, [envKey]: catcherUrl, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
});
const onChunk = (c) => {
  for (const line of String(c).split(/\r?\n/)) {
    if (line.trim()) logLines.push({ t: Date.now(), line: line.replace(/\x1b\[[0-9;]*m/g, '') });
  }
};
dev.stdout.on('data', onChunk);
dev.stderr.on('data', onChunk);

const stop = () => {
  if (keep) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { shell: true });
    else dev.kill('SIGTERM');
  } catch {}
};
const finish = (code) => {
  stop();
  restoreEnv();
  catcher.close();
  blobStub.close();
  setTimeout(() => process.exit(code), 400);
};
process.on('SIGINT', () => finish(130));

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 90_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(base + '/', { method: 'GET' });
    if (r.status < 500) { ready = true; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 700));
}
if (!ready) {
  console.error('astro dev never answered; last output:\n' + logLines.slice(-20).map((l) => l.line).join('\n'));
  finish(2);
}

// ---------- cases ----------
const clone = () => JSON.parse(JSON.stringify(basePayload));
const FILLED = 'http://spam.example';
const cases = [
  { n: 1, name: 'normal', body: () => ({ ...clone(), [secondsKey]: 95 }), status: 200, forwarded: true, flagged: false, log: /accepted/i },
  { n: 2, name: 'trap-slow', body: () => ({ ...clone(), [hpKey]: FILLED, [secondsKey]: 95 }), status: 200, forwarded: true, flagged: true, log: /flag|forward/i },
  { n: 3, name: 'trap-fast', body: () => ({ ...clone(), [hpKey]: FILLED, [secondsKey]: 4 }), status: 200, forwarded: true, flagged: true, log: /flag|forward/i },
  ...(oldKey ? [{ n: 4, name: 'old-key-fast', body: () => ({ ...clone(), [oldKey]: FILLED, [secondsKey]: 4 }), status: 200, forwarded: true, flagged: true, log: /flag|forward/i }] : []),
  { n: 5, name: 'no-seconds', body: () => { const b = { ...clone(), [hpKey]: FILLED }; delete b[secondsKey]; return b; }, status: 200, forwarded: true, flagged: true, log: /flag|forward/i },
  { n: 6, name: 'missing', body: () => ({ ...clone(), [requiredField]: '', [secondsKey]: 95 }), status: 400, forwarded: false, log: /rejected|missing|invalid/i },
  { n: 7, name: 'webhook-down', body: () => ({ ...clone(), [secondsKey]: 95 }), status: 200, forwarded: 'attempted', log: /lead webhook unreachable.*hp-test@example.com/i, catcherStatus: 500 },
];

const rows = [];
let failures = 0;
for (const c of cases) {
  received = [];
  blobCalls.length = 0;
  catcherStatus = c.catcherStatus ?? 200;
  const since = Date.now();
  let status = 0;
  let text = '';
  try {
    const r = await fetch(base + route, {
      signal: AbortSignal.timeout(40000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify(c.body()),
    });
    status = r.status;
    text = (await r.text()).slice(0, 120);
  } catch (e) {
    text = `fetch failed: ${e.message}`;
  }
  await new Promise((r) => setTimeout(r, 500));
  const lines = logLines.filter((l) => l.t >= since - 50 && l.line.includes(logPrefix) && !/^\s*\d\d:\d\d:\d\d\s+\[(200|400|502|500)\]/.test(l.line)).map((l) => l.line.trim());
  const gotForwarded = received.length > 0;
  const flagged = gotForwarded ? received[0]?.honeypotFilled : null;
  const checks = [];
  if (status !== c.status) checks.push(`status ${status} != ${c.status}`);
  if (c.forwarded === true && !gotForwarded) checks.push('not forwarded');
  if (c.forwarded === false && gotForwarded) checks.push('FORWARDED (should drop)');
  if (c.forwarded === 'attempted' && !gotForwarded) checks.push('webhook never called');
  if (c.flagged !== undefined && gotForwarded && flagged !== c.flagged) checks.push(`honeypotFilled ${flagged} != ${c.flagged}`);
  if (!lines.some((l) => c.log.test(l))) checks.push(`no log line matching ${c.log}`);
  if ((c.n === 1 || c.n === 2) && !blobCalls.some((b) => b.startsWith('PUT'))) checks.push('job record never written (stub saw no PUT)');
  if (c.n === 7) { if (received.length !== 2) checks.push(`expected 2 webhook attempts, got ${received.length}`); }
  else if (received.length > 1) checks.push(`webhook called ${received.length}x`);
  if (gotForwarded && received[0] && (hpKey in received[0] || (oldKey && oldKey in received[0]))) checks.push('trap value leaked into webhook payload');
  const pass = checks.length === 0;
  if (!pass) failures++;
  rows.push({ case: `${c.n} ${c.name}`, status, forwarded: gotForwarded, honeypotFilled: flagged, result: pass ? 'PASS' : 'FAIL: ' + checks.join('; ') });
  console.log(`\n## ${c.n} ${c.name}  ->  ${status}  ${text}`);
  for (const l of lines) console.log('   ' + l);
  if (!pass) console.log('   !! ' + checks.join('; '));
}

console.log('\n' + '='.repeat(72));
console.table(rows);
console.log(failures === 0 ? `ALL ${rows.length} CASES PASS  (${repo}${route})` : `${failures} FAILING`);
finish(failures === 0 ? 0 : 1);
