/**
 * Issue B web layer: invoice HTTP routes (server) and invoice screen (browser).
 * No Node imports: the browser loads this module too.
 */
import { HttpError, parsePage, requireBody, requireNoQuery } from './http.mjs';

const PAGE_SIZE = 2;

function requireAdmin(actor) {
  if (actor.role !== 'admin') throw new HttpError('FORBIDDEN', 'Readers may view invoices but cannot issue, pay or refund them');
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError('VALIDATION', `${name} must be a nonempty string`);
}

/**
 * Invoice routes. Error order for mutations: 401 (server) → 403 reader → 400 shape → idempotent replay → 404 resolution → 409 state.
 * POST /api/invoices resolves the reservation through the authenticated actor's reservation service;
 * the browser never supplies the billing event.
 */
export function billingRoutes({ reservations, billing }) {
  const transition = operation => ({ actor, params, query, body }) => {
    requireAdmin(actor);
    requireNoQuery(query);
    const { key, expectedVersion } = requireBody(body, ['key', 'expectedVersion']);
    return { status: 200, body: billing[operation](actor, { key, id: params.id, expectedVersion }) };
  };
  return [
    {
      method: 'POST', path: ['api', 'invoices'],
      handle: ({ actor, query, body }) => {
        requireAdmin(actor);
        requireNoQuery(query);
        const { key, reservationId } = requireBody(body, ['key', 'reservationId']);
        requireText(key, 'key');
        requireText(reservationId, 'reservationId');
        // Replay a previously successful request before resolving current reservation state, so a
        // retry still returns the original invoice after the reservation was later canceled.
        const replayed = billing.replayIssue(actor, { key, reservationId });
        if (replayed) return { status: 201, body: replayed };
        const event = reservations.get(actor, reservationId);
        if (event && typeof event === 'object' && event.status !== 'reserved') {
          throw new HttpError('CONFLICT', `Reservation ${reservationId} is ${event.status}; only reserved reservations can be invoiced`);
        }
        return { status: 201, body: billing.issue(actor, { key, event }) };
      },
    },
    {
      method: 'GET', path: ['api', 'invoices'],
      handle: ({ actor, query }) => ({ status: 200, body: billing.list(actor, parsePage(query)) }),
    },
    {
      method: 'GET', path: ['api', 'invoices', ':id'],
      handle: ({ actor, params, query }) => {
        requireNoQuery(query);
        return { status: 200, body: billing.get(actor, params.id) };
      },
    },
    { method: 'POST', path: ['api', 'invoices', ':id', 'pay'], handle: transition('pay') },
    { method: 'POST', path: ['api', 'invoices', ':id', 'refund'], handle: transition('refund') },
  ];
}

/**
 * Invoice screen bound to #invoices, #invoice-prev, #invoice-next, #invoice-pagination.
 * ctx: {api, mutate, message, describeFailure, canMutate}. Returns {refresh, issue(reservationId)}.
 */
export function mountInvoices(ctx) {
  const doc = globalThis.document;
  const tbody = doc.getElementById('invoices');
  const prev = doc.getElementById('invoice-prev');
  const next = doc.getElementById('invoice-next');
  const indicator = doc.getElementById('invoice-pagination');
  let page = 1;
  let pages = 1;
  let loaded = false;
  let requestSeq = 0;
  const busy = new Set();

  indicator.textContent = 'Invoices not loaded yet';
  prev.disabled = true;
  next.disabled = true;

  function cell(text) {
    const td = doc.createElement('td');
    td.textContent = String(text);
    return td;
  }

  function actionButton(label, enabled, onClick) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = !enabled;
    button.addEventListener('click', onClick);
    return button;
  }

  function render(items, total) {
    const rows = items.map(invoice => {
      const tr = doc.createElement('tr');
      tr.dataset.id = invoice.id;
      tr.append(cell(invoice.id), cell(invoice.reservationId), cell(invoice.amountCents), cell(invoice.status), cell(invoice.version));
      const actions = doc.createElement('td');
      const pending = busy.has(invoice.id);
      const pay = actionButton('Pay', ctx.canMutate && !pending && invoice.status === 'open', () => transition(invoice, 'pay', pay));
      const refund = actionButton('Refund', ctx.canMutate && !pending && invoice.status === 'paid', () => transition(invoice, 'refund', refund));
      actions.append(pay, ' ', refund);
      tr.append(actions);
      return tr;
    });
    if (rows.length === 0) {
      const tr = doc.createElement('tr');
      const td = cell(total === 0 ? 'No invoices yet' : 'No invoices on this page');
      td.colSpan = 6;
      tr.append(td);
      rows.push(tr);
    }
    tbody.replaceChildren(...rows);
    indicator.textContent = `Page ${page} of ${pages} · ${total} total`;
    prev.disabled = page <= 1;
    next.disabled = page >= pages;
  }

  async function load(attempt = 0) {
    const seq = ++requestSeq;
    let result;
    try {
      result = await ctx.api('GET', `/api/invoices?page=${page}&pageSize=${PAGE_SIZE}`);
    } catch {
      result = { ok: false, status: 0, body: { message: 'The server could not be reached while loading invoices; retry shortly' } };
    }
    if (seq !== requestSeq) return result; // a newer load superseded this one
    if (!result.ok) {
      ctx.message(ctx.describeFailure(result), 'error');
      return result;
    }
    const { items, total } = result.body;
    pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > pages && attempt === 0) { page = pages; return load(1); }
    loaded = true;
    render(items, total);
    return result;
  }

  async function refresh() { return load(); }

  async function showLastPage() {
    const result = await load();
    if (result.ok && page !== pages) { page = pages; return load(); }
    return result;
  }

  async function transition(invoice, operation, button) {
    if (busy.has(invoice.id)) return undefined;
    busy.add(invoice.id);
    button.disabled = true;
    let result;
    try {
      result = await ctx.mutate(`${operation}:${invoice.id}:${invoice.version}`,
        `/api/invoices/${encodeURIComponent(invoice.id)}/${operation}`, { expectedVersion: invoice.version });
    } finally {
      busy.delete(invoice.id);
    }
    if (result.ok) {
      ctx.message(`Invoice ${result.body.id} is now ${result.body.status}`);
      await refresh();
    } else {
      ctx.message(ctx.describeFailure(result), 'error');
      if (result.status === 409) await refresh();
      else if (button.isConnected) button.disabled = false; // e.g. network failure: retry reuses the same key
    }
    return result;
  }

  async function issue(reservationId) {
    const result = await ctx.mutate(`issue:${reservationId}`, '/api/invoices', { reservationId });
    if (result.ok) {
      ctx.message(`Invoice ${result.body.id} issued for reservation ${result.body.reservationId}`);
      await showLastPage();
    } else {
      ctx.message(ctx.describeFailure(result), 'error');
      if (result.status === 409) await refresh();
    }
    return result;
  }

  prev.addEventListener('click', () => { if (loaded && page > 1) { page -= 1; load(); } });
  next.addEventListener('click', () => { if (loaded && page < pages) { page += 1; load(); } });

  return { refresh, issue };
}
