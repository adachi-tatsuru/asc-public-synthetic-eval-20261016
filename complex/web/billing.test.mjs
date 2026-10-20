/**
 * Issue B real-HTTP tests: spawns web/server.mjs (PORT=0, temporary DATA_FILE) and exercises the
 * invoice routes end to end. Reservations are created through the reservation HTTP routes, so this
 * suite needs the integrated reservation Issue. Run: node --test complex/web/billing.test.mjs
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-http-'));
const dataFile = path.join(dir, 'state.sqlite');
let server, origin;

async function start() {
  server = spawn(process.execPath, [path.join(here, 'server.mjs')], { env: { ...process.env, PORT: '0', DATA_FILE: dataFile }, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: server.stdout });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Server exited before ready: ${code}`)));
    lines.once('line', line => { try { resolve(JSON.parse(line).port); } catch (e) { reject(e); } });
  });
  lines.close();
  assert.ok(Number.isInteger(port) && port > 0);
  origin = `http://127.0.0.1:${port}`;
}

async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const ended = once(server, 'exit');
    server.kill('SIGTERM');
    await ended;
  }
  server = undefined;
}

/** Send a request; `raw` sends the body text verbatim. Asserts status and error shape. */
async function call(method, route, { body, raw, session = 'alpha-admin', status = 200, type = 'application/json' } = {}) {
  const headers = { accept: 'application/json' };
  if (type) headers['content-type'] = type;
  if (session) headers['x-fixture-session'] = session;
  const init = { method, headers };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(origin + route, init);
  const value = await response.json();
  assert.equal(response.status, status, `${method} ${route} ${JSON.stringify(value)}`);
  if (status >= 400) {
    assert.equal(typeof value.code, 'string');
    assert.ok(typeof value.message === 'string' && value.message.trim(), 'error message must be actionable');
  }
  return value;
}

const invoicePath = id => `/api/invoices/${encodeURIComponent(id)}`;
const invoiceTotal = async (session = 'alpha-admin') => (await call('GET', '/api/invoices?page=1&pageSize=50', { session })).total;

const state = {};

before(async () => {
  await start();
  await call('POST', '/api/reservations/seed', { body: { sku: 'seat', available: 10, unitCents: 25 } });
  await call('POST', '/api/reservations/seed', { body: { sku: 'seat', available: 5, unitCents: 10 }, session: 'beta-admin' });
  state.r1 = await call('POST', '/api/reservations', { body: { key: 'r1', sku: 'seat', quantity: 2 }, status: 201 });
  state.r2 = await call('POST', '/api/reservations', { body: { key: 'r2', sku: 'seat', quantity: 1 }, status: 201 });
  state.r3 = await call('POST', '/api/reservations', { body: { key: 'r3', sku: 'seat', quantity: 3 }, status: 201 });
  state.b1 = await call('POST', '/api/reservations', { body: { key: 'r1', sku: 'seat', quantity: 1 }, session: 'beta-admin', status: 201 });
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing or unknown session is 401 for every invoice route', async () => {
  for (const session of [null, 'alpha-owner', '']) {
    await call('GET', '/api/invoices', { session, status: 401 });
    await call('GET', invoicePath('x'), { session, status: 401 });
    await call('POST', '/api/invoices', { body: { key: 'k', reservationId: state.r1.id }, session, status: 401 });
    await call('POST', `${invoicePath('x')}/pay`, { body: { key: 'k', expectedVersion: 1 }, session, status: 401 });
  }
  assert.equal(await invoiceTotal(), 0);
});

test('issue rejects readers, forged events and malformed bodies without creating invoices', async () => {
  const id = state.r1.id;
  await call('POST', '/api/invoices', { body: { key: 'reader', reservationId: id }, session: 'alpha-reader', status: 403 });
  await call('POST', '/api/invoices', { body: { key: 'forged', event: state.r1 }, status: 400 });
  await call('POST', '/api/invoices', { body: { key: 'forged', reservationId: id, event: state.r1 }, status: 400 });
  for (const body of [null, [], 'text', 42, {}, { key: 'k' }, { reservationId: id }, { key: 'k', reservationId: id, tenant: 'beta' },
    { key: '', reservationId: id }, { key: 1, reservationId: id }, { key: 'k', reservationId: '' }, { key: 'k', reservationId: 7 }, { key: 'k', reservationId: null }]) {
    await call('POST', '/api/invoices', { body, status: 400 });
  }
  await call('POST', '/api/invoices', { raw: '{"key":"k","reservationId":', status: 400 });
  await call('POST', '/api/invoices', { raw: '{"key":"k","reservationId":"x","__proto__":{}}', status: 400 });
  await call('POST', '/api/invoices', { body: { key: 'k', reservationId: id }, type: 'text/plain', status: 415 });
  await call('POST', '/api/invoices?tenant=beta', { body: { key: 'k', reservationId: id }, status: 400 });
  await call('POST', '/api/invoices', { body: { key: 'missing', reservationId: 'no-such-reservation' }, status: 404 });
  await call('POST', '/api/invoices', { body: { key: 'cross', reservationId: id }, session: 'beta-admin', status: 404 });
  assert.equal(await invoiceTotal(), 0);
  assert.equal(await invoiceTotal('beta-admin'), 0);
});

test('issue creates one invoice per reservation with durable idempotent retries', async () => {
  const invoice = await call('POST', '/api/invoices', { body: { key: 'issue-1', reservationId: state.r1.id }, status: 201 });
  assert.deepEqual(invoice, { id: invoice.id, tenant: 'alpha', reservationId: state.r1.id, amountCents: 50, status: 'open', version: 1 });
  assert.deepEqual(await call('POST', '/api/invoices', { body: { key: 'issue-1', reservationId: state.r1.id }, status: 201 }), invoice);
  await call('POST', '/api/invoices', { body: { key: 'issue-1', reservationId: state.r2.id }, status: 409 });
  await call('POST', '/api/invoices', { body: { key: 'issue-again', reservationId: state.r1.id }, status: 409 });
  await call('POST', '/api/invoices', { body: { key: 'issue-1', reservationId: state.r1.id }, session: 'alpha-reader', status: 403 });
  assert.equal(await invoiceTotal(), 1);
  // the rejected key 'issue-1' for r2 was not consumed differently; a fresh key issues r2
  state.inv2 = await call('POST', '/api/invoices', { body: { key: 'issue-2', reservationId: state.r2.id }, status: 201 });
  // tenants may reuse keys independently
  const beta = await call('POST', '/api/invoices', { body: { key: 'issue-1', reservationId: state.b1.id }, session: 'beta-admin', status: 201 });
  assert.equal(beta.tenant, 'beta'); assert.equal(beta.amountCents, 10);
  state.invoice = invoice; state.beta = beta;
});

test('get is tenant-scoped and readable by readers', async () => {
  const { invoice, beta } = state;
  assert.deepEqual(await call('GET', invoicePath(invoice.id), { session: 'alpha-reader' }), invoice);
  await call('GET', invoicePath(invoice.id), { session: 'beta-admin', status: 404 });
  await call('GET', invoicePath(beta.id), { status: 404 });
  await call('GET', invoicePath('no/such invoice'), { status: 404 });
  await call('GET', `${invoicePath(invoice.id)}?x=1`, { status: 400 });
});

test('pay and refund reject bad input, readers, other tenants and stale versions without change', async () => {
  const { invoice } = state;
  const pay = `${invoicePath(invoice.id)}/pay`, refund = `${invoicePath(invoice.id)}/refund`;
  await call('POST', pay, { body: { key: 'reader-pay', expectedVersion: 1 }, session: 'alpha-reader', status: 403 });
  await call('POST', refund, { body: { key: 'reader-refund', expectedVersion: 1 }, session: 'alpha-reader', status: 403 });
  await call('POST', pay, { body: { key: 'cross', expectedVersion: 1 }, session: 'beta-admin', status: 404 });
  await call('POST', `${invoicePath('missing')}/pay`, { body: { key: 'missing', expectedVersion: 1 }, status: 404 });
  for (const body of [null, [], {}, { key: 'p' }, { expectedVersion: 1 }, { key: 'p', expectedVersion: 1, id: 'other' },
    { key: 'p', expectedVersion: '1' }, { key: 'p', expectedVersion: 1.5 }, { key: 'p', expectedVersion: 0 }, { key: 'p', expectedVersion: -1 },
    { key: 'p', expectedVersion: null }, { key: '', expectedVersion: 1 }, { key: 3, expectedVersion: 1 }]) {
    await call('POST', pay, { body, status: 400 });
  }
  await call('POST', pay, { raw: '{"key":"p","expectedVersion":9007199254740993}', status: 400 });
  await call('POST', pay, { raw: '{"key":"p","expectedVersion":1e400}', status: 400 });
  await call('POST', pay, { raw: 'not json', status: 400 });
  await call('POST', `${pay}?force=1`, { body: { key: 'p', expectedVersion: 1 }, status: 400 });
  await call('POST', pay, { body: { key: 'stale-pay', expectedVersion: 9 }, status: 409 });
  await call('POST', refund, { body: { key: 'refund-open', expectedVersion: 1 }, status: 409 });
  assert.deepEqual(await call('GET', invoicePath(invoice.id)), invoice);
});

test('pay then refund with replay-before-version, key reuse conflicts and stale tabs', async () => {
  const { invoice } = state;
  const pay = `${invoicePath(invoice.id)}/pay`, refund = `${invoicePath(invoice.id)}/refund`;
  // keys that were rejected above remain usable
  const paid = await call('POST', pay, { body: { key: 'p', expectedVersion: 1 } });
  assert.deepEqual(paid, { ...invoice, status: 'paid', version: 2 });
  assert.deepEqual(await call('POST', pay, { body: { key: 'p', expectedVersion: 1 } }), paid);
  await call('POST', pay, { body: { key: 'p', expectedVersion: 2 }, status: 409 });
  await call('POST', pay, { body: { key: 'p', expectedVersion: 1 }, session: 'alpha-reader', status: 403 });
  await call('POST', pay, { body: { key: 'stale-tab', expectedVersion: 1 }, status: 409 });
  await call('POST', pay, { body: { key: 'pay-paid', expectedVersion: 2 }, status: 409 });
  await call('POST', refund, { body: { key: 'stale-refund', expectedVersion: 1 }, status: 409 });
  assert.deepEqual(await call('GET', invoicePath(invoice.id)), paid);
  const refunded = await call('POST', refund, { body: { key: 'refund', expectedVersion: 2 } });
  assert.deepEqual(refunded, { ...invoice, status: 'refunded', version: 3 });
  assert.deepEqual(await call('POST', refund, { body: { key: 'refund', expectedVersion: 2 } }), refunded);
  assert.deepEqual(await call('POST', pay, { body: { key: 'p', expectedVersion: 1 } }), paid);
  await call('POST', refund, { body: { key: 'refund-again', expectedVersion: 3 }, status: 409 });
  await call('POST', `${invoicePath(state.beta.id)}/refund`, { body: { key: 'refund-cross', expectedVersion: 1 }, status: 404 });
  assert.deepEqual(await call('GET', invoicePath(invoice.id), { session: 'alpha-reader' }), refunded);
  assert.equal((await call('GET', invoicePath(state.beta.id), { session: 'beta-admin' })).status, 'open');
  state.paid = paid; state.refunded = refunded;
});

test('list paginates by creation order, defaults to page 1 of size 2 and rejects invalid queries', async () => {
  const third = await call('POST', '/api/invoices', { body: { key: 'issue-3', reservationId: state.r3.id }, status: 201 });
  const first = await call('GET', '/api/invoices', { session: 'alpha-reader' });
  assert.deepEqual(first, { items: [state.refunded, state.inv2], total: 3 });
  assert.deepEqual(await call('GET', '/api/invoices?page=2&pageSize=2'), { items: [third], total: 3 });
  assert.deepEqual(await call('GET', '/api/invoices?pageSize=1&page=3'), { items: [third], total: 3 });
  assert.deepEqual(await call('GET', '/api/invoices?page=99'), { items: [], total: 3 });
  assert.deepEqual(await call('GET', '/api/invoices', { session: 'beta-admin' }), { items: [state.beta], total: 1 });
  for (const q of ['page=0', 'pageSize=0', 'pageSize=51', 'page=1.5', 'page=abc', 'page=', 'page=%2B1', 'page=01', 'page=-1',
    'page=1&page=2', 'tenant=beta', 'page=1&pageSize=2&role=admin', 'page=99999999999999999']) {
    await call('GET', `/api/invoices?${q}`, { status: 400 });
  }
  state.third = third;
});

test('issuing a canceled reservation is a conflict, but a prior issue replays after cancel', async () => {
  const r4 = await call('POST', '/api/reservations', { body: { key: 'r4', sku: 'seat', quantity: 1 }, status: 201 });
  const r5 = await call('POST', '/api/reservations', { body: { key: 'r5', sku: 'seat', quantity: 1 }, status: 201 });
  const inv4 = await call('POST', '/api/invoices', { body: { key: 'issue-4', reservationId: r4.id }, status: 201 });
  await call('POST', `/api/reservations/${encodeURIComponent(r4.id)}/cancel`, { body: { key: 'cancel-r4', expectedVersion: 1 } });
  // retry of the successful request replays the original invoice despite the later cancellation
  assert.deepEqual(await call('POST', '/api/invoices', { body: { key: 'issue-4', reservationId: r4.id }, status: 201 }), inv4);
  // replay still requires authority; readers and other tenants learn nothing
  await call('POST', '/api/invoices', { body: { key: 'issue-4', reservationId: r4.id }, session: 'alpha-reader', status: 403 });
  await call('POST', '/api/invoices', { body: { key: 'issue-4', reservationId: r4.id }, session: 'beta-admin', status: 404 });
  // a genuinely new request for the canceled reservation is a conflict
  await call('POST', '/api/invoices', { body: { key: 'issue-4-new', reservationId: r4.id }, status: 409 });
  // reusing the key for a different reservation is a conflict and does not invoice r5
  await call('POST', '/api/invoices', { body: { key: 'issue-4', reservationId: r5.id }, status: 409 });
  // a canceled reservation that never had an invoice cannot be invoiced
  await call('POST', `/api/reservations/${encodeURIComponent(r5.id)}/cancel`, { body: { key: 'cancel-r5', expectedVersion: 1 } });
  await call('POST', '/api/invoices', { body: { key: 'issue-5', reservationId: r5.id }, status: 409 });
  // cancellation leaves existing invoices unchanged
  await call('POST', `/api/reservations/${encodeURIComponent(state.r3.id)}/cancel`, { body: { key: 'cancel-r3', expectedVersion: 1 } });
  assert.deepEqual(await call('GET', invoicePath(state.third.id)), state.third);
  assert.deepEqual(await call('GET', invoicePath(inv4.id)), inv4);
  assert.equal(await invoiceTotal(), 4);
  state.r4 = r4; state.r5 = r5; state.inv4 = inv4;
});

test('unknown routes and methods never invoke another operation', async () => {
  const id = state.inv2.id;
  await call('PUT', '/api/invoices', { body: { key: 'k', reservationId: state.r1.id }, status: 405 });
  await call('DELETE', invoicePath(id), { status: 405 });
  await call('POST', invoicePath(id), { body: { key: 'k', expectedVersion: 1 }, status: 405 });
  await call('GET', `${invoicePath(id)}/pay`, { status: 405 });
  await call('PATCH', `${invoicePath(id)}/refund`, { body: { key: 'k', expectedVersion: 1 }, status: 405 });
  await call('POST', `${invoicePath(id)}/void`, { body: { key: 'k', expectedVersion: 1 }, status: 404 });
  await call('POST', `${invoicePath(id)}/pay/now`, { body: { key: 'k', expectedVersion: 1 }, status: 404 });
  await call('GET', '/api/invoice', { status: 404 });
  await call('GET', '/api/invoices/%E0%A4%A', { status: 400 });
  assert.equal((await call('GET', invoicePath(id))).status, 'open');
});

test('invoices, idempotency records and replays survive a server restart', async () => {
  await stop();
  await start();
  const { invoice, paid, refunded } = state;
  assert.deepEqual(await call('GET', invoicePath(invoice.id)), refunded);
  assert.deepEqual(await call('POST', '/api/invoices', { body: { key: 'issue-1', reservationId: state.r1.id }, status: 201 }), invoice);
  await call('POST', '/api/invoices', { body: { key: 'issue-after-restart', reservationId: state.r1.id }, status: 409 });
  assert.deepEqual(await call('POST', `${invoicePath(invoice.id)}/pay`, { body: { key: 'p', expectedVersion: 1 } }), paid);
  assert.deepEqual(await call('POST', `${invoicePath(invoice.id)}/refund`, { body: { key: 'refund', expectedVersion: 2 } }), refunded);
  await call('POST', `${invoicePath(invoice.id)}/refund`, { body: { key: 'refund', expectedVersion: 2 }, session: 'alpha-reader', status: 403 });
  // replay-after-cancel survives restart; new keys and key reuse still conflict
  assert.deepEqual(await call('POST', '/api/invoices', { body: { key: 'issue-4', reservationId: state.r4.id }, status: 201 }), state.inv4);
  await call('POST', '/api/invoices', { body: { key: 'issue-4-restart', reservationId: state.r4.id }, status: 409 });
  await call('POST', '/api/invoices', { body: { key: 'issue-4', reservationId: state.r5.id }, status: 409 });
  const page = await call('GET', '/api/invoices?page=1&pageSize=50');
  assert.equal(page.total, 4);
  assert.deepEqual(page.items.map(i => i.status), ['refunded', 'open', 'open', 'open']);
});
