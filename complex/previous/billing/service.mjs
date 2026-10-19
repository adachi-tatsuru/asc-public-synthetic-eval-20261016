import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const INVOICE_KEYS = ['id', 'tenant', 'reservationId', 'amountCents', 'status', 'version'];
const EVENT_KEYS = ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version'];

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateActor(actor) {
  if (!hasExactKeys(actor, ['tenant', 'role']) ||
      !nonemptyString(actor.tenant) ||
      (actor.role !== 'admin' && actor.role !== 'reader')) {
    throw failure('AUTH', 'Invalid actor');
  }
  return actor;
}

function requireAdmin(actor) {
  validateActor(actor);
  if (actor.role !== 'admin') throw failure('FORBIDDEN', 'Mutation requires admin role');
}

function validateIssueInput(input) {
  if (!hasExactKeys(input, ['key', 'event']) || !nonemptyString(input.key)) {
    throw failure('VALIDATION', 'Invalid issue input');
  }
  const event = input.event;
  if (!hasExactKeys(event, EVENT_KEYS) ||
      !nonemptyString(event.id) ||
      !nonemptyString(event.tenant) ||
      !nonemptyString(event.sku) ||
      !safeInteger(event.quantity, 1) ||
      !safeInteger(event.amountCents, 0) ||
      event.status !== 'reserved' ||
      !safeInteger(event.version, 1)) {
    throw failure('VALIDATION', 'Invalid reservation event');
  }
  return {
    key: input.key,
    event: {
      id: event.id,
      tenant: event.tenant,
      sku: event.sku,
      quantity: event.quantity,
      amountCents: event.amountCents,
      status: event.status,
      version: event.version,
    },
  };
}

function validateTransitionInput(input) {
  if (!hasExactKeys(input, ['key', 'id', 'expectedVersion']) ||
      !nonemptyString(input.key) ||
      !nonemptyString(input.id) ||
      !safeInteger(input.expectedVersion, 1)) {
    throw failure('VALIDATION', 'Invalid transition input');
  }
  return { key: input.key, id: input.id, expectedVersion: input.expectedVersion };
}

function validateListInput(input) {
  if (!hasExactKeys(input, ['page', 'pageSize']) ||
      !safeInteger(input.page, 1) ||
      !safeInteger(input.pageSize, 1) ||
      input.pageSize > 50) {
    throw failure('VALIDATION', 'Invalid pagination');
  }
  return input;
}

function publicInvoice(row) {
  return Object.freeze({
    id: row.id,
    tenant: row.tenant,
    reservationId: row.reservation_id ?? row.reservationId,
    amountCents: row.amount_cents ?? row.amountCents,
    status: row.status,
    version: row.version,
  });
}

function deserializeInvoice(json) {
  const value = JSON.parse(json);
  const row = Object.fromEntries(INVOICE_KEYS.map((key) => [key, value[key]]));
  return Object.freeze(row);
}

export class BillingService {
  #db;
  #closed = false;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS billing_invoices (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'refunded')),
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
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Preserve the error that caused the transaction to fail.
      }
      throw error;
    }
  }

  #replayOrConflict(tenant, operation, key, requestJson) {
    const row = this.#db.prepare(`
      SELECT request_json, result_json
      FROM billing_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.request_json !== requestJson) {
      throw failure('CONFLICT', 'Idempotency key was used with different input');
    }
    return deserializeInvoice(row.result_json);
  }

  #remember(tenant, operation, key, requestJson, result) {
    this.#db.prepare(`
      INSERT INTO billing_idempotency
        (tenant, operation, idempotency_key, request_json, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, requestJson, JSON.stringify(result));
  }

  issue(actor, input) {
    requireAdmin(actor);
    const normalized = validateIssueInput(input);
    if (normalized.event.tenant !== actor.tenant) {
      throw failure('FORBIDDEN', 'Reservation event belongs to another tenant');
    }
    const requestJson = JSON.stringify(normalized);

    return this.#transaction(() => {
      const replay = this.#replayOrConflict(actor.tenant, 'issue', normalized.key, requestJson);
      if (replay) return replay;

      const existing = this.#db.prepare(`
        SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, normalized.event.id);
      if (existing) throw failure('CONFLICT', 'Reservation already has an invoice');

      let id;
      do {
        id = randomUUID();
      } while (this.#db.prepare('SELECT 1 FROM billing_invoices WHERE id = ?').get(id));

      this.#db.prepare(`
        INSERT INTO billing_invoices
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, 'open', 1)
      `).run(id, actor.tenant, normalized.event.id, normalized.event.amountCents);

      const result = publicInvoice({
        id,
        tenant: actor.tenant,
        reservationId: normalized.event.id,
        amountCents: normalized.event.amountCents,
        status: 'open',
        version: 1,
      });
      this.#remember(actor.tenant, 'issue', normalized.key, requestJson, result);
      return result;
    });
  }

  pay(actor, input) {
    return this.#transition(actor, input, 'pay', 'open', 'paid');
  }

  refund(actor, input) {
    return this.#transition(actor, input, 'refund', 'paid', 'refunded');
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    requireAdmin(actor);
    const normalized = validateTransitionInput(input);
    const requestJson = JSON.stringify(normalized);

    return this.#transaction(() => {
      const replay = this.#replayOrConflict(actor.tenant, operation, normalized.key, requestJson);
      if (replay) return replay;

      const row = this.#db.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices WHERE tenant = ? AND id = ?
      `).get(actor.tenant, normalized.id);
      if (!row) throw failure('NOT_FOUND', 'Invoice not found');
      if (row.version !== normalized.expectedVersion || row.status !== fromStatus) {
        throw failure('CONFLICT', 'Invoice state or version does not permit transition');
      }

      this.#db.prepare(`
        UPDATE billing_invoices SET status = ?, version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(toStatus, actor.tenant, normalized.id);
      const result = publicInvoice({ ...row, status: toStatus, version: row.version + 1 });
      this.#remember(actor.tenant, operation, normalized.key, requestJson, result);
      return result;
    });
  }

  get(actor, id) {
    validateActor(actor);
    if (!nonemptyString(id)) throw failure('VALIDATION', 'Invalid invoice id');
    const row = this.#db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) throw failure('NOT_FOUND', 'Invoice not found');
    return publicInvoice(row);
  }

  list(actor, input) {
    validateActor(actor);
    const { page, pageSize } = validateListInput(input);
    const { total } = this.#db.prepare(`
      SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?
    `).get(actor.tenant);

    let rows = [];
    if (page - 1 <= Math.floor(Number.MAX_SAFE_INTEGER / pageSize)) {
      const offset = (page - 1) * pageSize;
      rows = this.#db.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices
        WHERE tenant = ?
        ORDER BY sequence
        LIMIT ? OFFSET ?
      `).all(actor.tenant, pageSize, offset);
    }
    const items = Object.freeze(rows.map(publicInvoice));
    return Object.freeze({ items, total });
  }

  close() {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
}
