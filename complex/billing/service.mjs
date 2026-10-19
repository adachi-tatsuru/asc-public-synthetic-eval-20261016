import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const EVENT_KEYS = ['amountCents', 'id', 'quantity', 'sku', 'status', 'tenant', 'version'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function hasExactlyKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || actual.some(key => typeof key !== 'string')) return false;
  const allowed = new Set(expected);
  return actual.every(key => allowed.has(key));
}

function requireNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function requireSafeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateActor(actor) {
  if (
    actor === null ||
    typeof actor !== 'object' ||
    !requireNonemptyString(actor.tenant) ||
    (actor.role !== 'admin' && actor.role !== 'reader')
  ) fail('AUTH', 'Invalid actor');
  return actor;
}

function requireAdmin(actor) {
  validateActor(actor);
  if (actor.role !== 'admin') fail('FORBIDDEN', 'Mutation is not permitted');
}

function validateEvent(event) {
  if (
    !hasExactlyKeys(event, EVENT_KEYS) ||
    !requireNonemptyString(event.id) ||
    !requireNonemptyString(event.tenant) ||
    !requireNonemptyString(event.sku) ||
    !requireSafeInteger(event.quantity, 1) ||
    !requireSafeInteger(event.amountCents, 0) ||
    event.status !== 'reserved' ||
    !requireSafeInteger(event.version, 1)
  ) fail('VALIDATION', 'Invalid reservation event');
}

function validateIssueInput(input) {
  if (!hasExactlyKeys(input, ['key', 'event']) || !requireNonemptyString(input.key)) {
    fail('VALIDATION', 'Invalid issue input');
  }
  validateEvent(input.event);
}

function validateTransitionInput(input) {
  if (
    !hasExactlyKeys(input, ['key', 'id', 'expectedVersion']) ||
    !requireNonemptyString(input.key) ||
    !requireNonemptyString(input.id) ||
    !requireSafeInteger(input.expectedVersion, 1)
  ) fail('VALIDATION', 'Invalid transition input');
}

function validateListInput(input) {
  if (
    !hasExactlyKeys(input, ['page', 'pageSize']) ||
    !requireSafeInteger(input.page, 1) ||
    !requireSafeInteger(input.pageSize, 1) ||
    input.pageSize > 50
  ) fail('VALIDATION', 'Invalid pagination');
}

function invoiceFromRow(row) {
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
  return JSON.stringify({
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
  });
}

function canonicalTransition(input) {
  return JSON.stringify({
    key: input.key,
    id: input.id,
    expectedVersion: input.expectedVersion,
  });
}

function inTransaction(database, action) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the operation error if SQLite already ended the transaction.
    }
    throw error;
  }
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
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
    `);
  }

  #replay(tenant, operation, key, inputJson) {
    const record = this.#database.prepare(`
      SELECT input_json, result_json
      FROM billing_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (record === undefined) return undefined;
    if (record.input_json !== inputJson) fail('CONFLICT', 'Idempotency key was reused');
    return JSON.parse(record.result_json);
  }

  #remember(tenant, operation, key, inputJson, result) {
    this.#database.prepare(`
      INSERT INTO billing_idempotency
        (tenant, operation, idempotency_key, input_json, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, inputJson, JSON.stringify(result));
  }

  issue(actor, input) {
    requireAdmin(actor);
    validateIssueInput(input);
    if (input.event.tenant !== actor.tenant) fail('FORBIDDEN', 'Event tenant does not match actor');

    const inputJson = canonicalIssue(input);
    return inTransaction(this.#database, () => {
      const replay = this.#replay(actor.tenant, 'issue', input.key, inputJson);
      if (replay !== undefined) return replay;

      const existing = this.#database.prepare(`
        SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, input.event.id);
      if (existing !== undefined) fail('CONFLICT', 'Reservation already has an invoice');

      const result = {
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
      `).run(
        result.id,
        result.tenant,
        result.reservationId,
        result.amountCents,
        result.status,
        result.version,
      );
      this.#remember(actor.tenant, 'issue', input.key, inputJson, result);
      return result;
    });
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    requireAdmin(actor);
    validateTransitionInput(input);
    const inputJson = canonicalTransition(input);

    return inTransaction(this.#database, () => {
      const replay = this.#replay(actor.tenant, operation, input.key, inputJson);
      if (replay !== undefined) return replay;

      const row = this.#database.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices
        WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (row === undefined) fail('NOT_FOUND', 'Invoice not found');
      if (row.version !== input.expectedVersion || row.status !== fromStatus) {
        fail('CONFLICT', 'Invoice cannot make this transition');
      }

      const nextVersion = row.version + 1;
      this.#database.prepare(`
        UPDATE billing_invoices SET status = ?, version = ?
        WHERE tenant = ? AND id = ?
      `).run(toStatus, nextVersion, actor.tenant, input.id);
      const result = invoiceFromRow({...row, status: toStatus, version: nextVersion});
      this.#remember(actor.tenant, operation, input.key, inputJson, result);
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
    if (!requireNonemptyString(id)) fail('VALIDATION', 'Invalid invoice id');
    const row = this.#database.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices
      WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (row === undefined) fail('NOT_FOUND', 'Invoice not found');
    return invoiceFromRow(row);
  }

  list(actor, input) {
    validateActor(actor);
    validateListInput(input);
    const total = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?
    `).get(actor.tenant).total;
    const offset = BigInt(input.page - 1) * BigInt(input.pageSize);
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return {items: [], total};
    const rows = this.#database.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices
      WHERE tenant = ?
      ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(actor.tenant, input.pageSize, Number(offset));
    return {items: rows.map(invoiceFromRow), total};
  }

  close() {
    this.#database.close();
  }
}
