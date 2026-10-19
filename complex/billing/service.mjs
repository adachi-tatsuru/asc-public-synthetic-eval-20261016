import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const INVOICE_KEYS = ['id', 'tenant', 'reservationId', 'amountCents', 'status', 'version'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function requireExactKeys(value, expected) {
  if (!hasExactKeys(value, expected)) fail('VALIDATION', 'Unexpected input shape');
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSafeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function authorize(actor, mutation = false) {
  if (
    actor === null ||
    typeof actor !== 'object' ||
    Array.isArray(actor) ||
    !isNonemptyString(actor.tenant) ||
    (actor.role !== 'admin' && actor.role !== 'reader')
  ) {
    fail('AUTH', 'Invalid actor');
  }
  if (mutation && actor.role !== 'admin') fail('FORBIDDEN', 'Mutation requires an admin');
}

function validateKey(key) {
  if (!isNonemptyString(key)) fail('VALIDATION', 'Invalid idempotency key');
}

function validateId(id) {
  if (!isNonemptyString(id)) fail('VALIDATION', 'Invalid id');
}

function validateExpectedVersion(version) {
  if (!isSafeInteger(version, 1)) fail('VALIDATION', 'Invalid expected version');
}

function publicInvoice(row) {
  const invoice = {
    id: row.id,
    tenant: row.tenant,
    reservationId: row.reservation_id,
    amountCents: row.amount_cents,
    status: row.status,
    version: row.version,
  };
  return Object.fromEntries(INVOICE_KEYS.map((key) => [key, invoice[key]]));
}

function canonicalIssueInput(input) {
  requireExactKeys(input, ['key', 'event']);
  validateKey(input.key);
  requireExactKeys(input.event, ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version', 'currency']);
  const event = input.event;
  if (
    !isNonemptyString(event.id) ||
    !isNonemptyString(event.tenant) ||
    !isNonemptyString(event.sku) ||
    !isSafeInteger(event.quantity, 1) ||
    !isSafeInteger(event.amountCents, 0) ||
    event.status !== 'reserved' ||
    !isSafeInteger(event.version, 1) ||
    event.currency !== 'JPY'
  ) {
    fail('VALIDATION', 'Invalid reservation event');
  }
  // Currency is fixed, so retaining the legacy canonical form keeps accepted
  // pre-revision issue operations replayable with revised reservation events.
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

function canonicalTransitionInput(input) {
  requireExactKeys(input, ['key', 'id', 'expectedVersion']);
  validateKey(input.key);
  validateId(input.id);
  validateExpectedVersion(input.expectedVersion);
  return JSON.stringify({ key: input.key, id: input.id, expectedVersion: input.expectedVersion });
}

export class BillingService {
  #db;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS billing_invoices_v1 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        UNIQUE (tenant, reservation_id)
      );
      CREATE INDEX IF NOT EXISTS billing_invoices_v1_tenant_sequence
        ON billing_invoices_v1 (tenant, sequence);
      CREATE TABLE IF NOT EXISTS billing_idempotency_v1 (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idem_key)
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
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Preserve the error that caused the rollback.
      }
      throw error;
    }
  }

  #replay(tenant, operation, key, canonicalInput) {
    const row = this.#db.prepare(`
      SELECT input_json, result_json
      FROM billing_idempotency_v1
      WHERE tenant = ? AND operation = ? AND idem_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.input_json !== canonicalInput) fail('CONFLICT', 'Idempotency key was reused');
    return JSON.parse(row.result_json);
  }

  #remember(tenant, operation, key, canonicalInput, result) {
    this.#db.prepare(`
      INSERT INTO billing_idempotency_v1
        (tenant, operation, idem_key, input_json, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  issue(actor, input) {
    authorize(actor, true);
    const canonicalInput = canonicalIssueInput(input);
    if (input.event.tenant !== actor.tenant) fail('FORBIDDEN', 'Event belongs to another tenant');

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, 'issue', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const duplicate = this.#db.prepare(`
        SELECT 1 FROM billing_invoices_v1 WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, input.event.id);
      if (duplicate) fail('CONFLICT', 'Reservation already has an invoice');

      const result = {
        id: randomUUID(),
        tenant: actor.tenant,
        reservationId: input.event.id,
        amountCents: input.event.amountCents,
        status: 'open',
        version: 1,
      };
      this.#db.prepare(`
        INSERT INTO billing_invoices_v1
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, 'open', 1)
      `).run(result.id, result.tenant, result.reservationId, result.amountCents);
      this.#remember(actor.tenant, 'issue', input.key, canonicalInput, result);
      return result;
    });
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    authorize(actor, true);
    const canonicalInput = canonicalTransitionInput(input);

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, operation, input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.#db.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices_v1
        WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (!row) fail('NOT_FOUND', 'Invoice not found');
      if (row.version !== input.expectedVersion || row.status !== fromStatus) {
        fail('CONFLICT', 'Invoice cannot make that transition');
      }

      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) fail('VALIDATION', 'Invoice version is too large');
      this.#db.prepare(`
        UPDATE billing_invoices_v1 SET status = ?, version = ?
        WHERE tenant = ? AND id = ? AND status = ? AND version = ?
      `).run(toStatus, nextVersion, actor.tenant, input.id, fromStatus, input.expectedVersion);
      const result = publicInvoice({ ...row, status: toStatus, version: nextVersion });
      this.#remember(actor.tenant, operation, input.key, canonicalInput, result);
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
    authorize(actor);
    validateId(id);
    const row = this.#db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices_v1
      WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) fail('NOT_FOUND', 'Invoice not found');
    return publicInvoice(row);
  }

  list(actor, input) {
    authorize(actor);
    requireExactKeys(input, ['page', 'pageSize']);
    if (!isSafeInteger(input.page, 1) || !isSafeInteger(input.pageSize, 1) || input.pageSize > 50) {
      fail('VALIDATION', 'Invalid pagination');
    }
    const total = this.#db.prepare(`
      SELECT count(*) AS total FROM billing_invoices_v1 WHERE tenant = ?
    `).get(actor.tenant).total;
    const offset = (BigInt(input.page) - 1n) * BigInt(input.pageSize);
    const rows = this.#db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices_v1
      WHERE tenant = ?
      ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(actor.tenant, input.pageSize, offset);
    return { items: rows.map(publicInvoice), total };
  }

  close() {
    this.#db.close();
  }
}
