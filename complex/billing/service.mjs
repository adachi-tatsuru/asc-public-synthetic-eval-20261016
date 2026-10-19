import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  keys.sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSafeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateActor(actor) {
  if (!hasExactKeys(actor, ['role', 'tenant']) ||
      !isNonemptyString(actor.tenant) ||
      (actor.role !== 'admin' && actor.role !== 'reader')) {
    throw failure('AUTH', 'Invalid actor');
  }
}

function requireAdmin(actor) {
  validateActor(actor);
  if (actor.role !== 'admin') throw failure('FORBIDDEN', 'Administrator role required');
}

function validateTransitionInput(input) {
  if (!hasExactKeys(input, ['expectedVersion', 'id', 'key']) ||
      !isNonemptyString(input.key) ||
      !isNonemptyString(input.id) ||
      !isSafeInteger(input.expectedVersion, 1)) {
    throw failure('VALIDATION', 'Invalid transition input');
  }
}

function publicInvoice(row) {
  return Object.freeze({
    id: row.id,
    tenant: row.tenant,
    reservationId: row.reservation_id,
    amountCents: row.amount_cents,
    status: row.status,
    version: row.version,
  });
}

function parseStoredResult(serialized) {
  return Object.freeze(JSON.parse(serialized));
}

export class BillingService {
  #db;
  #closed = false;

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
        status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'refunded')),
        version INTEGER NOT NULL,
        UNIQUE (tenant, reservation_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS billing_invoices_tenant_creation
        ON billing_invoices (tenant, creation_order);

      CREATE TABLE IF NOT EXISTS billing_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idem_key)
      ) WITHOUT ROWID, STRICT;
    `);
  }

  #transaction(action) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
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

  #replayOrConflict(tenant, operation, key, canonicalInput) {
    const row = this.#db.prepare(`
      SELECT canonical_input, result_json
      FROM billing_idempotency
      WHERE tenant = ? AND operation = ? AND idem_key = ?
    `).get(tenant, operation, key);
    if (!row) return null;
    if (row.canonical_input !== canonicalInput) {
      throw failure('CONFLICT', 'Idempotency key was used for different input');
    }
    return parseStoredResult(row.result_json);
  }

  #recordResult(tenant, operation, key, canonicalInput, result) {
    this.#db.prepare(`
      INSERT INTO billing_idempotency
        (tenant, operation, idem_key, canonical_input, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  issue(actor, input) {
    requireAdmin(actor);
    if (!hasExactKeys(input, ['event', 'key']) || !isNonemptyString(input.key)) {
      throw failure('VALIDATION', 'Invalid issue input');
    }
    const event = input.event;
    if (!hasExactKeys(event, ['amountCents', 'id', 'quantity', 'sku', 'status', 'tenant', 'version']) ||
        !isNonemptyString(event.id) ||
        !isNonemptyString(event.tenant) ||
        !isNonemptyString(event.sku) ||
        !isSafeInteger(event.quantity, 1) ||
        !isSafeInteger(event.amountCents, 0) ||
        event.status !== 'reserved' ||
        !isSafeInteger(event.version, 1)) {
      throw failure('VALIDATION', 'Invalid reservation event');
    }
    if (event.tenant !== actor.tenant) {
      throw failure('FORBIDDEN', 'Reservation event belongs to another tenant');
    }

    const canonicalInput = JSON.stringify({
      event: {
        id: event.id,
        tenant: event.tenant,
        sku: event.sku,
        quantity: event.quantity,
        amountCents: event.amountCents,
        status: event.status,
        version: event.version,
      },
    });

    return this.#transaction(() => {
      const replay = this.#replayOrConflict(actor.tenant, 'issue', input.key, canonicalInput);
      if (replay) return replay;

      const existing = this.#db.prepare(`
        SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, event.id);
      if (existing) throw failure('CONFLICT', 'Reservation already has an invoice');

      const id = randomUUID();
      this.#db.prepare(`
        INSERT INTO billing_invoices
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, 'open', 1)
      `).run(id, actor.tenant, event.id, event.amountCents);
      const result = Object.freeze({
        id,
        tenant: actor.tenant,
        reservationId: event.id,
        amountCents: event.amountCents,
        status: 'open',
        version: 1,
      });
      this.#recordResult(actor.tenant, 'issue', input.key, canonicalInput, result);
      return result;
    });
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    requireAdmin(actor);
    validateTransitionInput(input);
    const canonicalInput = JSON.stringify({id: input.id, expectedVersion: input.expectedVersion});

    return this.#transaction(() => {
      const replay = this.#replayOrConflict(actor.tenant, operation, input.key, canonicalInput);
      if (replay) return replay;

      const row = this.#db.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices
        WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (!row) throw failure('NOT_FOUND', 'Invoice not found');
      if (row.version !== input.expectedVersion || row.status !== fromStatus) {
        throw failure('CONFLICT', 'Invoice state does not permit this transition');
      }

      this.#db.prepare(`
        UPDATE billing_invoices SET status = ?, version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(toStatus, actor.tenant, input.id);
      const result = Object.freeze({
        id: row.id,
        tenant: row.tenant,
        reservationId: row.reservation_id,
        amountCents: row.amount_cents,
        status: toStatus,
        version: row.version + 1,
      });
      this.#recordResult(actor.tenant, operation, input.key, canonicalInput, result);
      return result;
    });
  }

  pay(actor, input) {
    return this.#transition(actor, input, 'pay', 'open', 'paid');
  }

  refund(actor, input) {
    return this.#transition(actor, input, 'refund', 'paid', 'refunded');
  }

  get(actor, id) {
    validateActor(actor);
    if (!isNonemptyString(id)) throw failure('VALIDATION', 'Invalid invoice ID');
    const row = this.#db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices
      WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) throw failure('NOT_FOUND', 'Invoice not found');
    return publicInvoice(row);
  }

  list(actor, input) {
    validateActor(actor);
    if (!hasExactKeys(input, ['page', 'pageSize']) ||
        !isSafeInteger(input.page, 1) ||
        !isSafeInteger(input.pageSize, 1) ||
        input.pageSize > 50) {
      throw failure('VALIDATION', 'Invalid pagination input');
    }

    const countRow = this.#db.prepare(`
      SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?
    `).get(actor.tenant);
    const total = countRow.total;
    if (total === 0 || input.page > Math.ceil(total / input.pageSize)) {
      return Object.freeze({items: Object.freeze([]), total});
    }
    const offset = (input.page - 1) * input.pageSize;
    const rows = this.#db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices
      WHERE tenant = ?
      ORDER BY creation_order
      LIMIT ? OFFSET ?
    `).all(actor.tenant, input.pageSize, offset);
    const items = Object.freeze(rows.map(publicInvoice));
    return Object.freeze({items, total});
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
