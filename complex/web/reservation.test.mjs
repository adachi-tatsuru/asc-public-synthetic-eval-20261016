/** Issue R real-HTTP tests: spawn web/server.mjs on PORT=0 with a temporary DATA_FILE. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');

async function startServer(dataFile) {
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0', DATA_FILE: dataFile }, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited before ready: ${code}`)));
    lines.once('line', line => { try { resolve(JSON.parse(line).port); } catch (e) { reject(e); } });
  });
  lines.close();
  child.removeAllListeners('exit');
  const origin = `http://127.0.0.1:${port}`;
  return {
    async stop() {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
    },
    /** `raw` sends the body string verbatim. */
    async request(method, route, { body, raw, session = 'alpha-admin', contentType = 'application/json' } = {}) {
      const headers = {};
      if (session) headers['x-fixture-session'] = session;
      if (body !== undefined || raw !== undefined) headers['content-type'] = contentType;
      const response = await fetch(origin + route, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      const value = await response.json();
      if (response.status >= 400) {
        assert.equal(typeof value.code, 'string', `${method} ${route} error code`);
        assert.ok(typeof value.message === 'string' && value.message.trim(), `${method} ${route} error message`);
      }
      return { status: response.status, body: value };
    },
  };
}

function withServer(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-http-'));
    const dataFile = path.join(dir, 'state.sqlite');
    const servers = [];
    const start = async () => { const s = await startServer(dataFile); servers.push(s); return s; };
    try { await fn(await start(), start); }
    finally { for (const s of servers) await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

const expectStatus = async (promise, status, code) => {
  const res = await promise;
  assert.equal(res.status, status, JSON.stringify(res.body));
  if (code) assert.equal(res.body.code, code);
  return res.body;
};
const seed = (s, sku = 'seat', available = 10, unitCents = 25, session = 'alpha-admin') =>
  s.request('POST', '/api/reservations/seed', { body: { sku, available, unitCents }, session });
const reserve = (s, body, session = 'alpha-admin') => s.request('POST', '/api/reservations', { body, session });
const available = async (s, sku = 'seat', session = 'alpha-admin') =>
  (await expectStatus(s.request('GET', `/api/inventory?sku=${encodeURIComponent(sku)}`, { session }), 200)).available;
const listAll = (s, session = 'alpha-admin') => expectStatus(s.request('GET', '/api/reservations?page=1&pageSize=50', { session }), 200);
const idPathOf = r => `/api/reservations/${encodeURIComponent(r.id)}`;

test('seed, reserve, get, list, cancel and inventory happy path', withServer(async s => {
  assert.deepEqual(await expectStatus(seed(s), 200), { sku: 'seat', available: 10, unitCents: 25 });
  const r = await expectStatus(reserve(s, { key: 'k1', sku: 'seat', quantity: 2 }), 201);
  assert.deepEqual(r, { id: r.id, tenant: 'alpha', sku: 'seat', quantity: 2, amountCents: 50, status: 'reserved', version: 1 });
  assert.equal(await available(s), 8);
  assert.deepEqual(await expectStatus(s.request('GET', idPathOf(r), { session: 'alpha-reader' }), 200), r);
  for (const key of ['k2', 'k3']) await expectStatus(reserve(s, { key, sku: 'seat', quantity: 1 }), 201);
  const def = await expectStatus(s.request('GET', '/api/reservations', { session: 'alpha-reader' }), 200);
  assert.equal(def.total, 3); assert.equal(def.items.length, 2); assert.deepEqual(def.items[0], r);
  const p2 = await expectStatus(s.request('GET', '/api/reservations?page=2&pageSize=2'), 200);
  assert.equal(p2.items.length, 1); assert.equal(p2.total, 3);
  assert.deepEqual(await expectStatus(s.request('GET', '/api/reservations?page=9&pageSize=2'), 200), { items: [], total: 3 });
  const c = await expectStatus(s.request('POST', `${idPathOf(r)}/cancel`, { body: { key: 'c1', expectedVersion: 1 } }), 200);
  assert.deepEqual(c, { ...r, status: 'canceled', version: 2 });
  assert.equal(await available(s), 8);
  assert.deepEqual(await expectStatus(s.request('GET', idPathOf(r)), 200), c);
  assert.deepEqual(await expectStatus(s.request('GET', '/api/reservations', { session: 'beta-admin' }), 200), { items: [], total: 0 });
}));

test('authentication: missing or unknown session is 401 and changes nothing', withServer(async s => {
  await expectStatus(seed(s), 200);
  for (const session of [null, 'alpha-root', 'ALPHA-ADMIN']) {
    await expectStatus(s.request('GET', '/api/reservations', { session }), 401, 'AUTH');
    await expectStatus(s.request('GET', '/api/inventory?sku=seat', { session }), 401, 'AUTH');
    await expectStatus(reserve(s, { key: 'x', sku: 'seat', quantity: 1 }, session), 401, 'AUTH');
    await expectStatus(seed(s, 'other', 1, 1, session), 401, 'AUTH');
  }
  assert.equal(await available(s), 10);
  assert.equal((await listAll(s)).total, 0);
  await expectStatus(s.request('GET', '/api/inventory?sku=other'), 404, 'NOT_FOUND');
}));

test('readers may read but every mutation is 403 without state change', withServer(async s => {
  await expectStatus(seed(s), 200);
  const r = await expectStatus(reserve(s, { key: 'k1', sku: 'seat', quantity: 2 }), 201);
  await expectStatus(seed(s, 'reader-sku', 5, 1, 'alpha-reader'), 403, 'FORBIDDEN');
  await expectStatus(reserve(s, { key: 'r1', sku: 'seat', quantity: 1 }, 'alpha-reader'), 403, 'FORBIDDEN');
  // Replaying an existing admin key still requires authorization.
  await expectStatus(reserve(s, { key: 'k1', sku: 'seat', quantity: 2 }, 'alpha-reader'), 403, 'FORBIDDEN');
  await expectStatus(s.request('POST', `${idPathOf(r)}/cancel`, { body: { key: 'c', expectedVersion: 1 }, session: 'alpha-reader' }), 403, 'FORBIDDEN');
  assert.equal(await available(s, 'seat', 'alpha-reader'), 8);
  await expectStatus(s.request('GET', '/api/inventory?sku=reader-sku', { session: 'alpha-reader' }), 404, 'NOT_FOUND');
  assert.equal((await expectStatus(s.request('GET', idPathOf(r), { session: 'alpha-reader' }), 200)).status, 'reserved');
  // Role is checked before body shape: invalid reader bodies are still 403, never 400.
  const cancelPath = `${idPathOf(r)}/cancel`;
  for (const [route, raw] of [['/api/reservations', '{}'], ['/api/reservations', '{"key":"r1","sku":"seat","quantity":1,"extra":true}'],
    ['/api/reservations', '{"key":"r1","sku":"seat","quantity":"1"}'], ['/api/reservations', 'null'], ['/api/reservations', '[]'],
    ['/api/reservations/seed', '{}'], ['/api/reservations/seed', '{"sku":"reader-sku","available":1,"unitCents":1,"tenant":"alpha"}'],
    [cancelPath, '{}'], [cancelPath, '{"key":"c","expectedVersion":"1"}'], [cancelPath, '{"key":"c","expectedVersion":1,"extra":1}']]) {
    const body = await expectStatus(s.request('POST', route, { raw, session: 'alpha-reader' }), 403, 'FORBIDDEN');
    assert.match(body.message, /admin/);
  }
  assert.equal(await available(s, 'seat', 'alpha-reader'), 8);
  assert.deepEqual(await expectStatus(s.request('GET', idPathOf(r), { session: 'alpha-reader' }), 200), r);
  assert.equal((await listAll(s, 'alpha-reader')).total, 1);
  await expectStatus(s.request('GET', '/api/inventory?sku=reader-sku', { session: 'alpha-reader' }), 404, 'NOT_FOUND');
  // The reader's rejected key was not consumed.
  assert.equal((await expectStatus(reserve(s, { key: 'r1', sku: 'seat', quantity: 1 }), 201)).quantity, 1);
}));

test('body validation: malformed JSON, non-objects, wrong keys, numeric strings, unsafe numbers', withServer(async s => {
  await expectStatus(seed(s), 200);
  const r = await expectStatus(reserve(s, { key: 'ok', sku: 'seat', quantity: 1 }), 201);
  const cancelPath = `${idPathOf(r)}/cancel`;
  for (const raw of ['{', '{"key":"a",}', '', 'undefined']) {
    for (const route of ['/api/reservations', cancelPath, '/api/reservations/seed']) await expectStatus(s.request('POST', route, { raw }), 400, 'VALIDATION');
  }
  await expectStatus(s.request('POST', '/api/reservations', { raw: '{"key":"t","sku":"seat","quantity":1}', contentType: 'text/plain' }), 415, 'UNSUPPORTED');
  const bad = [
    null, [], [{ key: 'b', sku: 'seat', quantity: 1 }], 'string', 7, {},
    { sku: 'seat', quantity: 1 }, { key: 'b', quantity: 1 }, { key: 'b', sku: 'seat' },
    { key: 'b', sku: 'seat', quantity: 1, tenant: 'beta' }, { key: 'b', sku: 'seat', quantity: 1, role: 'admin' },
    { key: 'b', sku: 'seat', quantity: '1' }, { key: 'b', sku: 'seat', quantity: 0 }, { key: 'b', sku: 'seat', quantity: -1 },
    { key: 'b', sku: 'seat', quantity: 1.5 }, { key: 'b', sku: 'seat', quantity: null }, { key: 'b', sku: 'seat', quantity: true },
    { key: 'b', sku: 'seat', quantity: [1] }, { key: '', sku: 'seat', quantity: 1 }, { key: 'b', sku: '', quantity: 1 },
    { key: 1, sku: 'seat', quantity: 1 }, { key: 'b', sku: 7, quantity: 1 },
  ];
  for (const body of bad) await expectStatus(reserve(s, body), 400, 'VALIDATION');
  for (const raw of ['{"key":"b","sku":"seat","quantity":9007199254740993}', '{"key":"b","sku":"seat","quantity":1e400}', '{"key":"b","sku":"seat","quantity":1e16}']) {
    await expectStatus(s.request('POST', '/api/reservations', { raw }), 400, 'VALIDATION');
  }
  for (const body of [null, [], {}, { key: 'c' }, { expectedVersion: 1 }, { key: 'c', expectedVersion: '1' }, { key: 'c', expectedVersion: 0 },
    { key: 'c', expectedVersion: 1, id: r.id }, { key: 'c', expectedVersion: 1, extra: true }, { key: 'c', expectedVersion: 2 ** 53 }]) {
    await expectStatus(s.request('POST', cancelPath, { body }), 400, 'VALIDATION');
  }
  for (const body of [null, [], { sku: 'n' }, { sku: 'n', available: '5', unitCents: 1 }, { sku: 'n', available: -1, unitCents: 1 },
    { sku: 'n', available: 1, unitCents: -1 }, { sku: 'n', available: 1, unitCents: 1.5 }, { sku: 'n', available: 1, unitCents: 1, tenant: 'beta' },
    { sku: '', available: 1, unitCents: 1 }]) {
    await expectStatus(s.request('POST', '/api/reservations/seed', { body }), 400, 'VALIDATION');
  }
  // Business-level rejections.
  await expectStatus(reserve(s, { key: 'b', sku: 'missing', quantity: 1 }), 404, 'NOT_FOUND');
  await expectStatus(reserve(s, { key: 'b', sku: 'seat', quantity: 10 }), 409, 'CONFLICT');
  await expectStatus(seed(s, 'seat', 99, 1), 409, 'CONFLICT');
  await expectStatus(seed(s, 'pricey', 3, Number.MAX_SAFE_INTEGER), 200);
  await expectStatus(reserve(s, { key: 'b', sku: 'pricey', quantity: 2 }), 400, 'VALIDATION');
  // None of the rejections changed durable state or consumed keys 'b' / 'c'.
  assert.deepEqual(await expectStatus(s.request('GET', '/api/inventory?sku=seat'), 200), { sku: 'seat', available: 9, unitCents: 25 });
  assert.equal(await available(s, 'pricey'), 3);
  await expectStatus(s.request('GET', '/api/inventory?sku=n'), 404, 'NOT_FOUND');
  const list = await listAll(s);
  assert.equal(list.total, 1); assert.equal(list.items[0].status, 'reserved'); assert.equal(list.items[0].version, 1);
  assert.equal((await expectStatus(reserve(s, { key: 'b', sku: 'seat', quantity: 3 }), 201)).quantity, 3);
  assert.equal((await expectStatus(s.request('POST', cancelPath, { body: { key: 'c', expectedVersion: 1 } }), 200)).status, 'canceled');
}));

test('query validation for list, get and inventory', withServer(async s => {
  await expectStatus(seed(s), 200);
  const r = await expectStatus(reserve(s, { key: 'ok', sku: 'seat', quantity: 1 }), 201);
  for (const q of ['page=0', 'page=abc', 'page=-1', 'page=1.5', 'page=01', 'page=', 'pageSize=0', 'pageSize=51', 'pageSize=1e1',
    'page=9007199254740993', 'page=1&page=2', 'page=1&pageSize=2&tenant=beta', 'secret=1', 'session=alpha-admin']) {
    await expectStatus(s.request('GET', `/api/reservations?${q}`), 400, 'VALIDATION');
  }
  assert.equal((await expectStatus(s.request('GET', '/api/reservations?pageSize=50'), 200)).total, 1);
  for (const q of ['', '?sku=', '?sku=seat&sku=seat', '?sku=seat&tenant=alpha', '?SKU=seat', '?other=1']) {
    await expectStatus(s.request('GET', `/api/inventory${q}`), 400, 'VALIDATION');
  }
  await expectStatus(s.request('GET', `${idPathOf(r)}?tenant=beta`), 400, 'VALIDATION');
  await expectStatus(s.request('POST', '/api/reservations?tenant=beta', { body: { key: 'q', sku: 'seat', quantity: 1 } }), 400, 'VALIDATION');
  await expectStatus(s.request('POST', '/api/reservations/seed?tenant=beta', { body: { sku: 'q', available: 1, unitCents: 1 } }), 400, 'VALIDATION');
  await expectStatus(s.request('POST', `${idPathOf(r)}/cancel?x=1`, { body: { key: 'q', expectedVersion: 1 } }), 400, 'VALIDATION');
  assert.equal(await available(s), 9);
  assert.equal((await listAll(s)).total, 1);
  await expectStatus(s.request('GET', '/api/inventory?sku=q'), 404, 'NOT_FOUND');
}));

test('tenant isolation: cross-tenant get, cancel and inventory are 404', withServer(async s => {
  await expectStatus(seed(s), 200);
  const r = await expectStatus(reserve(s, { key: 'k', sku: 'seat', quantity: 2 }), 201);
  await expectStatus(s.request('GET', idPathOf(r), { session: 'beta-admin' }), 404, 'NOT_FOUND');
  await expectStatus(s.request('POST', `${idPathOf(r)}/cancel`, { body: { key: 'k', expectedVersion: 1 }, session: 'beta-admin' }), 404, 'NOT_FOUND');
  await expectStatus(s.request('GET', '/api/inventory?sku=seat', { session: 'beta-admin' }), 404, 'NOT_FOUND');
  await expectStatus(reserve(s, { key: 'k', sku: 'seat', quantity: 1 }, 'beta-admin'), 404, 'NOT_FOUND');
  await expectStatus(s.request('GET', '/api/reservations/does-not-exist'), 404, 'NOT_FOUND');
  await expectStatus(s.request('GET', `/api/reservations/${encodeURIComponent('a/b c?d')}`), 404, 'NOT_FOUND');
  // Beta reuses the same SKU and key independently.
  await expectStatus(seed(s, 'seat', 3, 10, 'beta-admin'), 200);
  const b = await expectStatus(reserve(s, { key: 'k', sku: 'seat', quantity: 2 }, 'beta-admin'), 201);
  assert.equal(b.tenant, 'beta'); assert.equal(b.amountCents, 20); assert.notEqual(b.id, r.id);
  await expectStatus(s.request('GET', idPathOf(b)), 404, 'NOT_FOUND');
  assert.equal(await available(s), 8);
  assert.equal(await available(s, 'seat', 'beta-admin'), 1);
  assert.equal((await expectStatus(s.request('GET', idPathOf(r)), 200)).status, 'reserved');
}));

test('idempotent retries, key reuse conflict and stale cancel', withServer(async s => {
  await expectStatus(seed(s), 200);
  const r = await expectStatus(reserve(s, { key: 'k', sku: 'seat', quantity: 2 }), 201);
  assert.deepEqual(await expectStatus(reserve(s, { key: 'k', sku: 'seat', quantity: 2 }), 201), r);
  assert.equal(await available(s), 8);
  await expectStatus(reserve(s, { key: 'k', sku: 'seat', quantity: 3 }), 409, 'CONFLICT');
  assert.equal(await available(s), 8);
  assert.equal((await listAll(s)).total, 1);
  const cancelPath = `${idPathOf(r)}/cancel`;
  await expectStatus(s.request('POST', cancelPath, { body: { key: 'stale', expectedVersion: 2 } }), 409, 'CONFLICT');
  const c = await expectStatus(s.request('POST', cancelPath, { body: { key: 'c', expectedVersion: 1 } }), 200);
  assert.equal(c.version, 2);
  // Replay after the transition returns the original result without applying twice.
  assert.deepEqual(await expectStatus(s.request('POST', cancelPath, { body: { key: 'c', expectedVersion: 1 } }), 200), c);
  assert.deepEqual(await expectStatus(reserve(s, { key: 'k', sku: 'seat', quantity: 2 }), 201), r);
  assert.equal(await available(s), 10);
  // A stale tab with a new key cannot overwrite; canceled cannot be canceled again; key reuse with new input conflicts.
  await expectStatus(s.request('POST', cancelPath, { body: { key: 'stale-tab', expectedVersion: 1 } }), 409, 'CONFLICT');
  await expectStatus(s.request('POST', cancelPath, { body: { key: 'again', expectedVersion: 2 } }), 409, 'CONFLICT');
  await expectStatus(s.request('POST', cancelPath, { body: { key: 'c', expectedVersion: 2 } }), 409, 'CONFLICT');
  assert.equal(await available(s), 10);
  assert.deepEqual(await expectStatus(s.request('GET', idPathOf(r)), 200), c);
}));

test('unknown routes are 404 and wrong methods 405 without invoking operations', withServer(async s => {
  await expectStatus(seed(s), 200);
  const r = await expectStatus(reserve(s, { key: 'k', sku: 'seat', quantity: 1 }), 201);
  const idPath = idPathOf(r);
  await expectStatus(s.request('GET', '/api/reservations/seed'), 404, 'NOT_FOUND');
  for (const [method, route, body] of [
    ['DELETE', idPath], ['PUT', idPath, { status: 'canceled' }], ['PATCH', '/api/reservations', {}], ['GET', `${idPath}/cancel`],
    ['DELETE', '/api/reservations'], ['POST', '/api/inventory', { sku: 'seat' }], ['POST', idPath, { key: 'x', expectedVersion: 1 }],
    ['PUT', '/api/reservations/seed', { sku: 'z', available: 1, unitCents: 1 }],
  ]) await expectStatus(s.request(method, route, { body }), 405, 'METHOD');
  for (const [method, route] of [['POST', `${idPath}/uncancel`], ['GET', '/api/reservation'], ['POST', '/api/reservations/seed/extra'],
    ['GET', '/api/inventory/seat'], ['POST', `${idPath}/cancel/now`]]) {
    await expectStatus(s.request(method, route, { body: method === 'POST' ? { key: 'x', expectedVersion: 1 } : undefined }), 404, 'NOT_FOUND');
  }
  assert.equal(await available(s), 9);
  assert.equal((await expectStatus(s.request('GET', idPath), 200)).status, 'reserved');
  await expectStatus(s.request('GET', '/api/inventory?sku=z'), 404, 'NOT_FOUND');
}));

test('state and idempotency survive restart; two servers share one database', withServer(async (s, start) => {
  await expectStatus(seed(s), 200);
  const r = await expectStatus(reserve(s, { key: 'k', sku: 'seat', quantity: 2 }), 201);
  const cancelPath = `${idPathOf(r)}/cancel`;
  const c = await expectStatus(s.request('POST', cancelPath, { body: { key: 'c', expectedVersion: 1 } }), 200);
  const second = await start();
  assert.deepEqual(await expectStatus(reserve(second, { key: 'k', sku: 'seat', quantity: 2 }), 201), r);
  const other = await expectStatus(reserve(second, { key: 'k2', sku: 'seat', quantity: 4 }), 201);
  assert.equal(await available(s), 6);
  await s.stop(); await second.stop();
  const reopened = await start();
  assert.deepEqual(await expectStatus(reopened.request('GET', idPathOf(r)), 200), c);
  assert.deepEqual(await expectStatus(reserve(reopened, { key: 'k', sku: 'seat', quantity: 2 }), 201), r);
  assert.deepEqual(await expectStatus(reopened.request('POST', cancelPath, { body: { key: 'c', expectedVersion: 1 } }), 200), c);
  await expectStatus(reserve(reopened, { key: 'k', sku: 'seat', quantity: 1 }), 409, 'CONFLICT');
  assert.equal(await available(reopened), 6);
  assert.deepEqual(await listAll(reopened), { items: [c, other], total: 2 });
}));
