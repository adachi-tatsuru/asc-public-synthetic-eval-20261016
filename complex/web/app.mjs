/** Shared browser context: API access, messages, reader authority and idempotent retry keys. */
import { mountReservations } from './reservation.mjs';
import { mountInvoices } from './billing.mjs';

const messageEl = document.getElementById('message');
const pendingKeys = new Map();

function message(text, kind = 'info') {
  messageEl.textContent = text;
  messageEl.className = kind === 'error' ? 'error' : '';
}

async function api(method, path, body) {
  const init = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const response = await fetch(path, init);
  let value;
  try { value = await response.json(); } catch { value = { code: 'INTERNAL', message: `Unexpected response (${response.status})` }; }
  return { ok: response.ok, status: response.status, body: value };
}

function newKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Send a keyed mutation. `fingerprint` identifies the user's intended operation (route + input);
 * a network failure keeps its key so retrying the same operation cannot duplicate effects,
 * while any server response retires the key so a new operation gets a new one.
 * Resolves to {ok,status,body}; network failure resolves to {ok:false,status:0,body:{message}}.
 */
async function mutate(fingerprint, path, input) {
  let key = pendingKeys.get(fingerprint);
  if (!key) { key = newKey(); pendingKeys.set(fingerprint, key); }
  let result;
  try { result = await api('POST', path, { key, ...input }); }
  catch {
    return { ok: false, status: 0, body: { code: 'NETWORK', message: 'The server could not be reached; retry the same action to resend it safely' } };
  }
  pendingKeys.delete(fingerprint);
  return result;
}

function describeFailure(result) {
  const text = result.body?.message || `Request failed (${result.status})`;
  return result.status === 409 ? `${text} — the list was refreshed; review the latest state and retry if still needed` : text;
}

async function start() {
  const sessionEl = document.getElementById('session');
  let actor;
  try {
    const result = await api('GET', '/api/session');
    if (result.ok) actor = result.body;
    else message(result.body.message, 'error');
  } catch { message('The server could not be reached; reload to retry', 'error'); }
  sessionEl.textContent = actor ? `Tenant ${actor.tenant}, ${actor.role}${actor.role === 'reader' ? ' (read-only)' : ''}` : 'No fixture session';
  const ctx = { api, mutate, message, describeFailure, canMutate: actor?.role === 'admin' };
  const invoices = mountInvoices(ctx);
  const reservations = mountReservations({ ...ctx, issueInvoice: reservationId => invoices.issue(reservationId) });
  if (actor) await Promise.all([reservations.refresh(), invoices.refresh()]);
}

start();
