import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function dataObject(value, keys, code = 'VALIDATION') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure(code, 'Expected an object');
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      throw failure(code, 'Unexpected object keys');
    }
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure(code, 'Accessors are not supported');
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (error) {
    if (error?.code === code) throw error;
    throw failure(code, 'Input object could not be inspected');
  }
}

function actorFor(actor, mutation) {
  const copy = dataObject(actor, ['tenant', 'role'], 'AUTH');
  if (typeof copy.tenant !== 'string' || copy.tenant.length === 0 ||
      (copy.role !== 'admin' && copy.role !== 'reader')) throw failure('AUTH', 'Invalid actor');
  if (mutation && copy.role !== 'admin') throw failure('FORBIDDEN', 'Actor may not mutate billing records');
  return copy;
}

const nonemptyString = (value) => typeof value === 'string' && value.length > 0;
const safeInteger = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;

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
  #db;
  #closed = false;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
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
        canonical_input TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
    `);
  }

  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  #replayOrRun(tenant, operation, key, canonical, work) {
    return this.#transaction(() => {
      const previous = this.#db.prepare(`
        SELECT canonical_input, result_json FROM billing_idempotency
        WHERE tenant = ? AND operation = ? AND idempotency_key = ?
      `).get(tenant, operation, key);
      if (previous) {
        if (previous.canonical_input !== canonical) throw failure('CONFLICT', 'Idempotency key input differs');
        return JSON.parse(previous.result_json);
      }
      const result = work();
      this.#db.prepare(`
        INSERT INTO billing_idempotency
          (tenant, operation, idempotency_key, canonical_input, result_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(tenant, operation, key, canonical, JSON.stringify(result));
      return result;
    });
  }

  issue(actor, input) {
    const principal = actorFor(actor, true);
    const request = dataObject(input, ['key', 'event']);
    if (!nonemptyString(request.key)) throw failure('VALIDATION', 'Invalid idempotency key');
    const event = dataObject(request.event, ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version']);
    if (!nonemptyString(event.id) || !nonemptyString(event.tenant) || !nonemptyString(event.sku) ||
        !safeInteger(event.quantity, 1) || !safeInteger(event.amountCents, 0) ||
        event.status !== 'reserved' || !safeInteger(event.version, 1)) {
      throw failure('VALIDATION', 'Invalid reservation event');
    }
    if (event.tenant !== principal.tenant) throw failure('FORBIDDEN', 'Reservation belongs to another tenant');

    const canonical = JSON.stringify({key: request.key, event});
    return this.#replayOrRun(principal.tenant, 'issue', request.key, canonical, () => {
      if (this.#db.prepare(`SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?`)
          .get(principal.tenant, event.id)) {
        throw failure('CONFLICT', 'Invoice already exists for reservation');
      }
      const invoice = {
        id: randomUUID(), tenant: principal.tenant, reservationId: event.id,
        amountCents: event.amountCents, status: 'open', version: 1,
      };
      this.#db.prepare(`
        INSERT INTO billing_invoices (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(invoice.id, invoice.tenant, invoice.reservationId, invoice.amountCents, invoice.status, invoice.version);
      return invoice;
    });
  }

  pay(actor, input) { return this.#transition(actor, input, 'pay', 'open', 'paid'); }

  refund(actor, input) { return this.#transition(actor, input, 'refund', 'paid', 'refunded'); }

  #transition(actor, input, operation, fromStatus, toStatus) {
    const principal = actorFor(actor, true);
    const request = dataObject(input, ['key', 'id', 'expectedVersion']);
    if (!nonemptyString(request.key) || !nonemptyString(request.id) || !safeInteger(request.expectedVersion, 1)) {
      throw failure('VALIDATION', 'Invalid transition input');
    }
    const canonical = JSON.stringify(request);
    return this.#replayOrRun(principal.tenant, operation, request.key, canonical, () => {
      const row = this.#db.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices WHERE tenant = ? AND id = ?
      `).get(principal.tenant, request.id);
      if (!row) throw failure('NOT_FOUND', 'Invoice not found');
      if (row.version !== request.expectedVersion || row.status !== fromStatus) {
        throw failure('CONFLICT', 'Invoice cannot make this transition');
      }
      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) throw failure('VALIDATION', 'Invoice version is too large');
      this.#db.prepare(`
        UPDATE billing_invoices SET status = ?, version = ?
        WHERE tenant = ? AND id = ? AND status = ? AND version = ?
      `).run(toStatus, nextVersion, principal.tenant, request.id, fromStatus, row.version);
      return {
        id: row.id, tenant: row.tenant, reservationId: row.reservation_id,
        amountCents: row.amount_cents, status: toStatus, version: nextVersion,
      };
    });
  }

  get(actor, id) {
    const principal = actorFor(actor, false);
    if (!nonemptyString(id)) throw failure('VALIDATION', 'Invalid invoice id');
    const row = this.#db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ? AND id = ?
    `).get(principal.tenant, id);
    if (!row) throw failure('NOT_FOUND', 'Invoice not found');
    return publicInvoice(row);
  }

  list(actor, input) {
    const principal = actorFor(actor, false);
    const request = dataObject(input, ['page', 'pageSize']);
    if (!safeInteger(request.page, 1) || !safeInteger(request.pageSize, 1) || request.pageSize > 50) {
      throw failure('VALIDATION', 'Invalid pagination');
    }
    const total = Number(this.#db.prepare(`SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?`)
      .get(principal.tenant).total);
    const offset = (request.page - 1) * request.pageSize;
    if (!Number.isSafeInteger(offset)) return {items: [], total};
    const rows = this.#db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ? ORDER BY sequence ASC LIMIT ? OFFSET ?
    `).all(principal.tenant, request.pageSize, offset);
    return {items: rows.map(publicInvoice), total};
  }

  close() {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
}
