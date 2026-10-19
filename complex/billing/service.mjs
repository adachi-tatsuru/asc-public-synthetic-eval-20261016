import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function dataObject(value, keys) {
  if (value === null || typeof value !== 'object') return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function actorFor(value, mutation = false) {
  const actor = dataObject(value, ['tenant', 'role']);
  if (!actor || typeof actor.tenant !== 'string' || actor.tenant.length === 0 ||
      (actor.role !== 'admin' && actor.role !== 'reader')) throw failure('AUTH', 'Invalid actor');
  if (mutation && actor.role !== 'admin') throw failure('FORBIDDEN', 'Mutation requires admin role');
  return actor;
}

const nonemptyString = (value) => typeof value === 'string' && value.length > 0;
const safeInteger = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const canonical = (value) => JSON.stringify(value);

function validateId(id) {
  if (!nonemptyString(id)) throw failure('VALIDATION', 'Invalid id');
}

function publicInvoice(row) {
  return {
    id: row.id,
    tenant: row.tenant,
    reservationId: row.reservation_id,
    amountCents: row.amount_cents,
    status: row.status,
    version: row.version,
  };
}

export class BillingService {
  #database;
  #closed = false;

  constructor(filename) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS billing_invoices (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        UNIQUE (tenant, reservation_id)
      );
      CREATE INDEX IF NOT EXISTS billing_invoices_tenant_sequence
        ON billing_invoices (tenant, sequence);
      CREATE TABLE IF NOT EXISTS billing_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
    `);
  }

  #transaction(work) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  #replay(actor, operation, key, requestJson) {
    const row = this.#database.prepare(`
      SELECT request_json, result_json FROM billing_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(actor.tenant, operation, key);
    if (!row) return null;
    if (row.request_json !== requestJson) throw failure('CONFLICT', 'Idempotency key has different input');
    return JSON.parse(row.result_json);
  }

  #remember(actor, operation, key, requestJson, result) {
    this.#database.prepare(`
      INSERT INTO billing_idempotency
        (tenant, operation, idempotency_key, request_json, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(actor.tenant, operation, key, requestJson, canonical(result));
  }

  issue(actorValue, inputValue) {
    const actor = actorFor(actorValue, true);
    const input = dataObject(inputValue, ['key', 'event']);
    if (!input || !nonemptyString(input.key)) throw failure('VALIDATION', 'Invalid issue input');
    const event = dataObject(input.event, ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version']);
    if (!event || !nonemptyString(event.id) || !nonemptyString(event.tenant) || !nonemptyString(event.sku) ||
        !safeInteger(event.quantity, 1) || !safeInteger(event.amountCents, 0) || event.status !== 'reserved' ||
        !safeInteger(event.version, 1)) throw failure('VALIDATION', 'Invalid reservation event');
    if (event.tenant !== actor.tenant) throw failure('FORBIDDEN', 'Event tenant differs from actor tenant');

    const requestJson = canonical({event});
    return this.#transaction(() => {
      const replay = this.#replay(actor, 'issue', input.key, requestJson);
      if (replay) return replay;
      const existing = this.#database.prepare(`
        SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, event.id);
      if (existing) throw failure('CONFLICT', 'Reservation already has an invoice');
      const result = {
        id: randomUUID(), tenant: actor.tenant, reservationId: event.id,
        amountCents: event.amountCents, status: 'open', version: 1,
      };
      this.#database.prepare(`
        INSERT INTO billing_invoices (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, 'open', 1)
      `).run(result.id, result.tenant, result.reservationId, result.amountCents);
      this.#remember(actor, 'issue', input.key, requestJson, result);
      return {...result};
    });
  }

  pay(actorValue, inputValue) {
    return this.#transition(actorValue, inputValue, 'pay', 'open', 'paid');
  }

  refund(actorValue, inputValue) {
    return this.#transition(actorValue, inputValue, 'refund', 'paid', 'refunded');
  }

  #transition(actorValue, inputValue, operation, fromStatus, toStatus) {
    const actor = actorFor(actorValue, true);
    const input = dataObject(inputValue, ['key', 'id', 'expectedVersion']);
    if (!input || !nonemptyString(input.key) || !nonemptyString(input.id) || !safeInteger(input.expectedVersion, 1)) {
      throw failure('VALIDATION', `Invalid ${operation} input`);
    }
    const requestJson = canonical({id: input.id, expectedVersion: input.expectedVersion});
    return this.#transaction(() => {
      const replay = this.#replay(actor, operation, input.key, requestJson);
      if (replay) return replay;
      const row = this.#database.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (!row) throw failure('NOT_FOUND', 'Invoice not found');
      if (row.version !== input.expectedVersion || row.status !== fromStatus) {
        throw failure('CONFLICT', `Invalid invoice state for ${operation}`);
      }
      const result = {...publicInvoice(row), status: toStatus, version: row.version + 1};
      this.#database.prepare(`
        UPDATE billing_invoices SET status = ?, version = ? WHERE tenant = ? AND id = ?
      `).run(result.status, result.version, actor.tenant, input.id);
      this.#remember(actor, operation, input.key, requestJson, result);
      return {...result};
    });
  }

  get(actorValue, id) {
    const actor = actorFor(actorValue);
    validateId(id);
    const row = this.#database.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) throw failure('NOT_FOUND', 'Invoice not found');
    return publicInvoice(row);
  }

  list(actorValue, queryValue) {
    const actor = actorFor(actorValue);
    const query = dataObject(queryValue, ['page', 'pageSize']);
    if (!query || !safeInteger(query.page, 1) || !safeInteger(query.pageSize, 1) || query.pageSize > 50) {
      throw failure('VALIDATION', 'Invalid pagination');
    }
    const {total} = this.#database.prepare(`
      SELECT count(*) AS total FROM billing_invoices WHERE tenant = ?
    `).get(actor.tenant);
    const offset = (query.page - 1) * query.pageSize;
    const rows = Number.isSafeInteger(offset)
      ? this.#database.prepare(`
          SELECT id, tenant, reservation_id, amount_cents, status, version
          FROM billing_invoices WHERE tenant = ? ORDER BY sequence LIMIT ? OFFSET ?
        `).all(actor.tenant, query.pageSize, offset)
      : [];
    return {items: rows.map(publicInvoice), total};
  }

  close() {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }
}
