import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const EVENT_KEYS = ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version'];

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function snapshot(value, keys, code = 'VALIDATION') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure(code, 'Expected an object');
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch { throw failure(code, 'Could not inspect object'); }
  if (ownKeys.length !== keys.length || keys.some(key => !ownKeys.includes(key)) ||
      ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw failure(code, 'Unexpected object keys');
  }
  const result = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw failure(code, 'Could not inspect property'); }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure(code, 'Accessor properties are not accepted');
    result[key] = descriptor.value;
  }
  return result;
}

function actorValue(actor) {
  const value = snapshot(actor, ['tenant', 'role'], 'AUTH');
  if (typeof value.tenant !== 'string' || value.tenant.length === 0 ||
      (value.role !== 'admin' && value.role !== 'reader')) throw failure('AUTH', 'Invalid actor');
  return value;
}

function requireAdmin(actor) {
  const value = actorValue(actor);
  if (value.role !== 'admin') throw failure('FORBIDDEN', 'Mutation requires admin role');
  return value;
}

const nonempty = value => typeof value === 'string' && value.length > 0;
const positiveSafe = value => Number.isSafeInteger(value) && value > 0;
const nonnegativeSafe = value => Number.isSafeInteger(value) && value >= 0;

function copyInvoice(value) {
  return {id: value.id, tenant: value.tenant, reservationId: value.reservationId,
    amountCents: value.amountCents, status: value.status, version: value.version};
}

function rowInvoice(row) {
  return copyInvoice({id: row.id, tenant: row.tenant, reservationId: row.reservation_id,
    amountCents: row.amount_cents, status: row.status, version: row.version});
}

export class BillingService {
  #db;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS billing_invoices (
        creation_order INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        UNIQUE (tenant, reservation_id)
      );
      CREATE INDEX IF NOT EXISTS billing_invoices_tenant_order
        ON billing_invoices (tenant, creation_order);
      CREATE TABLE IF NOT EXISTS billing_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
    `);
  }

  #transaction(action) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  #replayOrConflict(tenant, operation, key, canonicalInput) {
    const row = this.#db.prepare(`SELECT canonical_input, result_json FROM billing_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?`).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonicalInput) throw failure('CONFLICT', 'Idempotency key was used with different input');
    return copyInvoice(JSON.parse(row.result_json));
  }

  #remember(tenant, operation, key, canonicalInput, result) {
    this.#db.prepare(`INSERT INTO billing_idempotency
      (tenant, operation, idempotency_key, canonical_input, result_json) VALUES (?, ?, ?, ?, ?)`)
      .run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  issue(actor, input) {
    const principal = requireAdmin(actor);
    const request = snapshot(input, ['key', 'event']);
    if (!nonempty(request.key)) throw failure('VALIDATION', 'Invalid idempotency key');
    const event = snapshot(request.event, EVENT_KEYS);
    if (!nonempty(event.id) || !nonempty(event.tenant) || !nonempty(event.sku) ||
        !positiveSafe(event.quantity) || !nonnegativeSafe(event.amountCents) ||
        event.status !== 'reserved' || !positiveSafe(event.version)) throw failure('VALIDATION', 'Invalid reservation event');
    if (event.tenant !== principal.tenant) throw failure('FORBIDDEN', 'Event tenant differs from actor tenant');
    const canonicalInput = JSON.stringify(event);
    return this.#transaction(() => {
      const replay = this.#replayOrConflict(principal.tenant, 'issue', request.key, canonicalInput);
      if (replay) return replay;
      const existing = this.#db.prepare('SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?')
        .get(principal.tenant, event.id);
      if (existing) throw failure('CONFLICT', 'Reservation already has an invoice');
      const result = {id: randomUUID(), tenant: principal.tenant, reservationId: event.id,
        amountCents: event.amountCents, status: 'open', version: 1};
      this.#db.prepare(`INSERT INTO billing_invoices
        (id, tenant, reservation_id, amount_cents, status, version) VALUES (?, ?, ?, ?, 'open', 1)`)
        .run(result.id, result.tenant, result.reservationId, result.amountCents);
      this.#remember(principal.tenant, 'issue', request.key, canonicalInput, result);
      return copyInvoice(result);
    });
  }

  #transition(operation, fromStatus, toStatus, actor, input) {
    const principal = requireAdmin(actor);
    const request = snapshot(input, ['key', 'id', 'expectedVersion']);
    if (!nonempty(request.key) || !nonempty(request.id) || !positiveSafe(request.expectedVersion))
      throw failure('VALIDATION', 'Invalid transition input');
    const canonicalInput = JSON.stringify({id: request.id, expectedVersion: request.expectedVersion});
    return this.#transaction(() => {
      const replay = this.#replayOrConflict(principal.tenant, operation, request.key, canonicalInput);
      if (replay) return replay;
      const row = this.#db.prepare(`SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices WHERE tenant = ? AND id = ?`).get(principal.tenant, request.id);
      if (!row) throw failure('NOT_FOUND', 'Invoice not found');
      if (row.version !== request.expectedVersion || row.status !== fromStatus)
        throw failure('CONFLICT', 'Invoice state or version does not permit transition');
      const nextVersion = row.version + 1;
      this.#db.prepare('UPDATE billing_invoices SET status = ?, version = ? WHERE tenant = ? AND id = ?')
        .run(toStatus, nextVersion, principal.tenant, request.id);
      const result = rowInvoice({...row, status: toStatus, version: nextVersion});
      this.#remember(principal.tenant, operation, request.key, canonicalInput, result);
      return copyInvoice(result);
    });
  }

  pay(actor, input) { return this.#transition('pay', 'open', 'paid', actor, input); }
  refund(actor, input) { return this.#transition('refund', 'paid', 'refunded', actor, input); }

  get(actor, id) {
    const principal = actorValue(actor);
    if (!nonempty(id)) throw failure('VALIDATION', 'Invalid invoice id');
    const row = this.#db.prepare(`SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ? AND id = ?`).get(principal.tenant, id);
    if (!row) throw failure('NOT_FOUND', 'Invoice not found');
    return rowInvoice(row);
  }

  list(actor, input) {
    const principal = actorValue(actor);
    const request = snapshot(input, ['page', 'pageSize']);
    if (!positiveSafe(request.page) || !positiveSafe(request.pageSize) || request.pageSize > 50)
      throw failure('VALIDATION', 'Invalid pagination');
    const total = this.#db.prepare('SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?')
      .get(principal.tenant).total;
    const offset = BigInt(request.page - 1) * BigInt(request.pageSize);
    if (offset >= BigInt(total)) return {items: [], total};
    const rows = this.#db.prepare(`SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ? ORDER BY creation_order LIMIT ? OFFSET ?`)
      .all(principal.tenant, request.pageSize, Number(offset));
    return {items: rows.map(rowInvoice), total};
  }

  close() { this.#db.close(); }
}
