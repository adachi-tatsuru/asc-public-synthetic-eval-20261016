/**
 * Issue R web layer: HTTP routes (server) and reservation screen (browser).
 * No Node imports: this module is also served to the browser.
 */
import { HttpError, parsePage, requireBody, requireNoQuery } from './http.mjs';

const PAGE_SIZE = 2;

/** Inventory lookup takes exactly one nonempty `sku` query parameter. */
function requireSku(query) {
  let sku;
  for (const [name, value] of query) {
    if (name !== 'sku') throw new HttpError('VALIDATION', `Unknown query parameter ${name}; only sku is accepted`);
    if (sku !== undefined) throw new HttpError('VALIDATION', 'Query parameter sku must appear once');
    sku = value;
  }
  if (!sku) throw new HttpError('VALIDATION', 'Query parameter sku is required, e.g. /api/inventory?sku=seat');
  return sku;
}

/** Reject readers before inspecting the body so authority errors never depend on input shape. */
function requireAdmin(actor, action) {
  if (actor.role !== 'admin') throw new HttpError('FORBIDDEN', `Readers may not ${action}; use an admin session (alpha-admin or beta-admin)`);
}

export function reservationRoutes({ reservations }) {
  return [
    {
      method: 'POST', path: ['api', 'reservations', 'seed'],
      handle: ({ actor, query, body }) => {
        requireAdmin(actor, 'seed inventory');
        requireNoQuery(query);
        const b = requireBody(body, ['sku', 'available', 'unitCents']);
        reservations.seed(actor, { sku: b.sku, available: b.available, unitCents: b.unitCents });
        return { status: 200, body: reservations.inventory(actor, b.sku) };
      },
    },
    {
      method: 'POST', path: ['api', 'reservations'],
      handle: ({ actor, query, body }) => {
        requireAdmin(actor, 'create reservations');
        requireNoQuery(query);
        const b = requireBody(body, ['key', 'sku', 'quantity']);
        return { status: 201, body: reservations.reserve(actor, { key: b.key, sku: b.sku, quantity: b.quantity }) };
      },
    },
    {
      method: 'GET', path: ['api', 'reservations'],
      handle: ({ actor, query }) => ({ status: 200, body: reservations.list(actor, parsePage(query)) }),
    },
    {
      method: 'GET', path: ['api', 'reservations', ':id'],
      handle: ({ actor, params, query }) => {
        requireNoQuery(query);
        return { status: 200, body: reservations.get(actor, params.id) };
      },
    },
    {
      method: 'POST', path: ['api', 'reservations', ':id', 'cancel'],
      handle: ({ actor, params, query, body }) => {
        requireAdmin(actor, 'cancel reservations');
        requireNoQuery(query);
        const b = requireBody(body, ['key', 'expectedVersion']);
        return { status: 200, body: reservations.cancel(actor, { key: b.key, id: params.id, expectedVersion: b.expectedVersion }) };
      },
    },
    {
      method: 'GET', path: ['api', 'inventory'],
      handle: ({ actor, query }) => ({ status: 200, body: reservations.inventory(actor, requireSku(query)) }),
    },
  ];
}

const CANONICAL_INT = /^(0|-?[1-9][0-9]*)$/;

/** Send a canonical safe integer as a number; anything else verbatim so the backend rejects it. */
function quantityValue(raw) {
  const trimmed = raw.trim();
  if (CANONICAL_INT.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isSafeInteger(n)) return n;
  }
  return raw;
}

function cell(doc, value) {
  const td = doc.createElement('td');
  td.textContent = String(value);
  return td;
}

/** Browser screen. ctx: {api, mutate, message, describeFailure, canMutate, issueInvoice}. */
export function mountReservations(ctx) {
  const doc = globalThis.document;
  const form = doc.getElementById('reservation-form');
  const skuEl = doc.getElementById('sku');
  const quantityEl = doc.getElementById('quantity');
  const reserveEl = doc.getElementById('reserve');
  const tbody = doc.getElementById('reservations');
  const prevEl = doc.getElementById('reservation-prev');
  const nextEl = doc.getElementById('reservation-next');
  const pagerEl = doc.getElementById('reservation-pagination');
  const canMutate = ctx.canMutate === true;

  let page = 1;
  let pages = 1;
  let generation = 0;

  for (const el of [skuEl, quantityEl, reserveEl]) el.disabled = !canMutate;
  prevEl.disabled = true;
  nextEl.disabled = true;

  function fail(result) {
    ctx.message(ctx.describeFailure(result), 'error');
  }

  function render(items, total) {
    const rows = items.map(item => {
      const tr = doc.createElement('tr');
      tr.dataset.id = item.id;
      for (const value of [item.id, item.sku, item.quantity, item.amountCents, item.status, item.version]) tr.append(cell(doc, value));
      const actions = doc.createElement('td');
      const actionable = canMutate && item.status === 'reserved';
      const cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.disabled = !actionable;
      cancel.addEventListener('click', () => runAction(cancel, () => cancelReservation(item)));
      const invoice = doc.createElement('button');
      invoice.type = 'button';
      invoice.textContent = 'Invoice';
      invoice.disabled = !actionable;
      invoice.addEventListener('click', () => runAction(invoice, () => issueInvoice(item)));
      actions.append(cancel, ' ', invoice);
      tr.append(actions);
      return tr;
    });
    tbody.replaceChildren(...rows);
    pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    pagerEl.textContent = `Page ${page} of ${pages} · ${total} total`;
    prevEl.disabled = page <= 1;
    nextEl.disabled = page >= pages;
  }

  async function refresh() {
    const mine = ++generation;
    let result;
    try { result = await ctx.api('GET', `/api/reservations?page=${page}&pageSize=${PAGE_SIZE}`); }
    catch { if (mine === generation) ctx.message('The server could not be reached; reload to retry', 'error'); return; }
    if (mine !== generation) return;
    if (!result.ok) { fail(result); return; }
    const { items, total } = result.body;
    const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > last) { page = last; return refresh(); }
    render(items, total);
  }

  /** Disable the clicked control while its request is pending; re-rendering replaces it afterwards. */
  async function runAction(button, action) {
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); } finally { if (button.isConnected) button.disabled = false; }
  }

  async function cancelReservation(item) {
    const result = await ctx.mutate(`cancel:${item.id}:${item.version}`,
      `/api/reservations/${encodeURIComponent(item.id)}/cancel`, { expectedVersion: item.version });
    if (result.ok) {
      ctx.message(`Reservation ${result.body.id} canceled (version ${result.body.version})`);
      await refresh();
      return;
    }
    fail(result);
    if (result.status === 409 || result.status === 404) await refresh();
  }

  async function issueInvoice(item) {
    let result;
    try { result = await ctx.issueInvoice(item.id); }
    catch { result = { ok: false, status: 0, body: { message: 'The server could not be reached; retry the same action to resend it safely' } }; }
    if (result?.ok) ctx.message(`Invoice issued for reservation ${item.id}`);
    else fail({ status: result?.status ?? 0, body: result?.body ?? { message: 'Invoice could not be issued' } });
    await refresh();
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!canMutate) { ctx.message('Read-only session: reservations cannot be created', 'error'); return; }
    runAction(reserveEl, async () => {
      const sku = skuEl.value;
      const quantity = quantityValue(quantityEl.value);
      const result = await ctx.mutate(`reserve:${JSON.stringify([sku, quantity])}`, '/api/reservations', { sku, quantity });
      if (result.ok) {
        ctx.message(`Reserved ${result.body.quantity} × ${result.body.sku} (reservation ${result.body.id})`);
        form.reset();
        await refresh();
      } else {
        fail(result);
        if (result.status === 409) await refresh();
      }
    });
  });

  prevEl.addEventListener('click', () => { if (page > 1) { page -= 1; refresh(); } });
  nextEl.addEventListener('click', () => { if (page < pages) { page += 1; refresh(); } });

  return { refresh };
}
