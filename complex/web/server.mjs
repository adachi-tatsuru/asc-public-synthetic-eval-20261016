/** Loopback HTTP server wiring both vertical Issues onto the shared HTTP/authentication contract. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReservationService } from '../reservation/service.mjs';
import { BillingService } from '../billing/service.mjs';
import { actorForSession, errorResponse, HttpError, matchRoute } from './http.mjs';
import { reservationRoutes } from './reservation.mjs';
import { billingRoutes } from './billing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
const STATIC = new Map([
  ['/', ['page.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/http.mjs', ['http.mjs', 'text/javascript; charset=utf-8']],
  ['/reservation.mjs', ['reservation.mjs', 'text/javascript; charset=utf-8']],
  ['/billing.mjs', ['billing.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'cache-control': 'no-store',
};

const dataFile = process.env.DATA_FILE;
if (!dataFile) {
  process.stderr.write('DATA_FILE must name the SQLite database file\n');
  process.exit(1);
}
const reservations = new ReservationService(dataFile);
const billing = new BillingService(dataFile);
const routes = [
  { method: 'GET', path: ['api', 'session'], handle: ({ actor }) => ({ status: 200, body: actor }) },
  ...reservationRoutes({ reservations }),
  ...billingRoutes({ reservations, billing }),
];

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') { req.resume(); reject(new HttpError('UNSUPPORTED', 'Send the request body as application/json')); return; }
    const chunks = []; let size = 0; let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) { failed = true; reject(new HttpError('TOO_LARGE', `Request body exceeds ${MAX_BODY} bytes`)); return; }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError('VALIDATION', 'Request body is not valid JSON')); }
    });
  });
}

function splitPath(pathname) {
  const raw = pathname.split('/').slice(1);
  try { return raw.map(s => decodeURIComponent(s)); }
  catch { throw new HttpError('VALIDATION', 'Malformed percent-encoding in URL path'); }
}

async function handleApi(req, res, url) {
  const actor = actorForSession(req.headers['x-fixture-session']);
  const segments = splitPath(url.pathname);
  const found = matchRoute(routes, req.method, segments);
  if (!found) return send(res, 404, { code: 'NOT_FOUND', message: `No API route ${req.method} ${url.pathname}` });
  if (found.methodNotAllowed) return send(res, 405, { code: 'METHOD', message: `Method ${req.method} is not allowed for ${url.pathname}` });
  const body = req.method === 'POST' ? await readBody(req) : undefined;
  const result = found.route.handle({ actor, params: found.params, query: url.searchParams, body });
  send(res, result.status, result.body);
}

function handleStatic(req, res, url) {
  const entry = STATIC.get(url.pathname);
  if (!entry) return send(res, 404, { code: 'NOT_FOUND', message: `No page at ${url.pathname}` });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { code: 'METHOD', message: 'Static pages accept GET only' }, { allow: 'GET, HEAD' });
  const content = fs.readFileSync(path.join(here, entry[0]));
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': entry[1], 'content-length': content.length });
  res.end(req.method === 'HEAD' ? undefined : content);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else handleStatic(req, res, url);
  } catch (error) {
    const { status, body } = errorResponse(error);
    if (status === 500) process.stderr.write(`${error?.stack ?? error}\n`);
    if (!res.headersSent) send(res, status, body); else res.destroy();
  }
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => {
    reservations.close();
    billing.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
