import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const ACTOR_KEYS = ['role', 'tenant'];
const ISSUE_KEYS = ['event', 'key'];
const EVENT_KEYS = ['amountCents', 'id', 'quantity', 'sku', 'status', 'tenant', 'version'];
const TRANSITION_KEYS = ['expectedVersion', 'id', 'key'];
const LIST_KEYS = ['page', 'pageSize'];

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length &&
    keys.every(key => typeof key === 'string' && expected.includes(key));
}

function validateActor(actor) {
  if (!hasExactKeys(actor, ACTOR_KEYS) ||
      typeof actor.tenant !== 'string' || actor.tenant.length === 0 ||
      (actor.role !== 'admin' && actor.role !== 'reader')) {
    throw serviceError('AUTH', 'Invalid actor');
  }
}

function requireAdmin(actor) {
  validateActor(actor);
  if (actor.role !== 'admin') throw serviceError('FORBIDDEN', 'Mutation requires admin role');
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateIssueInput(input) {
  if (!hasExactKeys(input, ISSUE_KEYS) || !nonemptyString(input.key) ||
      !hasExactKeys(input.event, EVENT_KEYS)) {
    throw serviceError('VALIDATION', 'Invalid issue input');
  }
  const event = input.event;
  if (!nonemptyString(event.id) || !nonemptyString(event.tenant) ||
      !nonemptyString(event.sku) || !safeInteger(event.quantity, 1) ||
      !safeInteger(event.amountCents, 0) || event.status !== 'reserved' ||
      !safeInteger(event.version, 1)) {
    throw serviceError('VALIDATION', 'Invalid reservation event');
  }
}

function validateTransitionInput(input) {
  if (!hasExactKeys(input, TRANSITION_KEYS) || !nonemptyString(input.key) ||
      !nonemptyString(input.id) || !safeInteger(input.expectedVersion, 1)) {
    throw serviceError('VALIDATION', 'Invalid transition input');
  }
}

function validateId(id) {
  if (!nonemptyString(id)) throw serviceError('VALIDATION', 'Invalid id');
}

function validateListInput(input) {
  if (!hasExactKeys(input, LIST_KEYS) || !safeInteger(input.page, 1) ||
      !safeInteger(input.pageSize, 1) || input.pageSize > 50) {
    throw serviceError('VALIDATION', 'Invalid pagination');
  }
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

function canonicalIssue(input) {
  const event = input.event;
  return JSON.stringify([
    input.key, event.id, event.tenant, event.sku, event.quantity,
    event.amountCents, event.status, event.version,
  ]);
}

function canonicalTransition(input) {
  return JSON.stringify([input.key, input.id, input.expectedVersion]);
}

export class BillingService {
  #database;

  constructor(filename) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec(`
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

  #transaction(action) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the error that caused the transaction to fail.
      }
      throw error;
    }
  }

  #replay(tenant, operation, key, canonicalInput) {
    const row = this.#database.prepare(`
      SELECT canonical_input, result_json
      FROM billing_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonicalInput) {
      throw serviceError('CONFLICT', 'Idempotency key was used with different input');
    }
    return JSON.parse(row.result_json);
  }

  #record(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
      INSERT INTO billing_idempotency
        (tenant, operation, idempotency_key, canonical_input, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  issue(actor, input) {
    requireAdmin(actor);
    validateIssueInput(input);
    if (input.event.tenant !== actor.tenant) {
      throw serviceError('FORBIDDEN', 'Reservation event belongs to another tenant');
    }
    const canonicalInput = canonicalIssue(input);
    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, 'issue', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const duplicate = this.#database.prepare(`
        SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, input.event.id);
      if (duplicate) throw serviceError('CONFLICT', 'Reservation already has an invoice');

      const invoice = {
        id: randomUUID(),
        tenant: actor.tenant,
        reservationId: input.event.id,
        amountCents: input.event.amountCents,
        status: 'open',
        version: 1,
      };
      this.#database.prepare(`
        INSERT INTO billing_invoices
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(invoice.id, invoice.tenant, invoice.reservationId, invoice.amountCents,
        invoice.status, invoice.version);
      this.#record(actor.tenant, 'issue', input.key, canonicalInput, invoice);
      return {...invoice};
    });
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    requireAdmin(actor);
    validateTransitionInput(input);
    const canonicalInput = canonicalTransition(input);
    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, operation, input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.#database.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (!row) throw serviceError('NOT_FOUND', 'Invoice not found');
      if (row.version !== input.expectedVersion || row.status !== fromStatus) {
        throw serviceError('CONFLICT', 'Invoice state or version does not permit transition');
      }

      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) {
        throw serviceError('VALIDATION', 'Invoice version exceeds safe integer range');
      }
      this.#database.prepare(`
        UPDATE billing_invoices SET status = ?, version = ?
        WHERE tenant = ? AND id = ? AND status = ? AND version = ?
      `).run(toStatus, nextVersion, actor.tenant, input.id, fromStatus, row.version);
      const result = publicInvoice({...row, status: toStatus, version: nextVersion});
      this.#record(actor.tenant, operation, input.key, canonicalInput, result);
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
    validateId(id);
    const row = this.#database.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) throw serviceError('NOT_FOUND', 'Invoice not found');
    return publicInvoice(row);
  }

  list(actor, input) {
    validateActor(actor);
    validateListInput(input);
    const total = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?
    `).get(actor.tenant).total;
    const offset = (input.page - 1) * input.pageSize;
    if (!Number.isSafeInteger(offset)) return {items: [], total};
    const rows = this.#database.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices
      WHERE tenant = ?
      ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(actor.tenant, input.pageSize, offset);
    return {items: rows.map(publicInvoice), total};
  }

  close() {
    this.#database.close();
  }
}
