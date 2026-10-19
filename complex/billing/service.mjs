import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const INVOICES = 'billing_9002_invoices';
const IDEMPOTENCY = 'billing_9002_idempotency';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function authorize(actor, mutation = false) {
  if (!hasExactKeys(actor, ['tenant', 'role'])
      || !nonemptyString(actor.tenant)
      || (actor.role !== 'admin' && actor.role !== 'reader')) {
    fail('AUTH', 'Invalid actor');
  }
  if (mutation && actor.role !== 'admin') fail('FORBIDDEN', 'Mutation requires admin');
}

function validateKey(key) {
  if (!nonemptyString(key)) fail('VALIDATION', 'Invalid idempotency key');
}

function validateId(id) {
  if (!nonemptyString(id)) fail('VALIDATION', 'Invalid id');
}

function validateTransitionInput(input) {
  if (!hasExactKeys(input, ['key', 'id', 'expectedVersion'])) {
    fail('VALIDATION', 'Invalid mutation input');
  }
  validateKey(input.key);
  validateId(input.id);
  if (!safeInteger(input.expectedVersion, 1)) fail('VALIDATION', 'Invalid expectedVersion');
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
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.closed = false;
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${INVOICES} (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        UNIQUE (tenant, reservation_id)
      );
      CREATE INDEX IF NOT EXISTS billing_9002_invoices_tenant_sequence
        ON ${INVOICES} (tenant, sequence);
      CREATE TABLE IF NOT EXISTS ${IDEMPOTENCY} (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
    `);
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure if SQLite has already ended the transaction.
      }
      throw error;
    }
  }

  replay(tenant, operation, key, canonical) {
    const row = this.db.prepare(`
      SELECT canonical_input, result
      FROM ${IDEMPOTENCY}
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonical) fail('CONFLICT', 'Idempotency key conflict');
    return JSON.parse(row.result);
  }

  remember(tenant, operation, key, canonical, result) {
    this.db.prepare(`
      INSERT INTO ${IDEMPOTENCY}
        (tenant, operation, idempotency_key, canonical_input, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonical, JSON.stringify(result));
  }

  issue(actor, input) {
    authorize(actor, true);
    if (!hasExactKeys(input, ['key', 'event'])) fail('VALIDATION', 'Invalid issue input');
    validateKey(input.key);
    const event = input.event;
    if (!hasExactKeys(event, [
      'id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version',
    ])) fail('VALIDATION', 'Invalid reservation event');
    if (!nonemptyString(event.id)
        || !nonemptyString(event.tenant)
        || !nonemptyString(event.sku)
        || !safeInteger(event.quantity, 1)
        || !safeInteger(event.amountCents, 0)
        || event.status !== 'reserved'
        || !safeInteger(event.version, 1)) {
      fail('VALIDATION', 'Invalid reservation event');
    }
    if (event.tenant !== actor.tenant) fail('FORBIDDEN', 'Event tenant mismatch');

    const canonical = JSON.stringify({
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
    return this.transaction(() => {
      const replay = this.replay(actor.tenant, 'issue', input.key, canonical);
      if (replay !== undefined) return replay;
      const duplicate = this.db.prepare(`
        SELECT 1 FROM ${INVOICES} WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, event.id);
      if (duplicate) fail('CONFLICT', 'Reservation already invoiced');

      const invoice = {
        id: randomUUID(),
        tenant: actor.tenant,
        reservationId: event.id,
        amountCents: event.amountCents,
        status: 'open',
        version: 1,
      };
      this.db.prepare(`
        INSERT INTO ${INVOICES}
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, 'open', 1)
      `).run(invoice.id, invoice.tenant, invoice.reservationId, invoice.amountCents);
      this.remember(actor.tenant, 'issue', input.key, canonical, invoice);
      return invoice;
    });
  }

  transition(actor, input, operation, fromStatus, toStatus) {
    authorize(actor, true);
    validateTransitionInput(input);
    const canonical = JSON.stringify({id: input.id, expectedVersion: input.expectedVersion});
    return this.transaction(() => {
      const replay = this.replay(actor.tenant, operation, input.key, canonical);
      if (replay !== undefined) return replay;
      const row = this.db.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM ${INVOICES} WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (!row) fail('NOT_FOUND', 'Invoice not found');
      if (row.version !== input.expectedVersion || row.status !== fromStatus) {
        fail('CONFLICT', 'Invoice state conflict');
      }
      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) fail('VALIDATION', 'Invoice version overflow');
      this.db.prepare(`
        UPDATE ${INVOICES} SET status = ?, version = ?
        WHERE tenant = ? AND id = ?
      `).run(toStatus, nextVersion, actor.tenant, input.id);
      const result = publicInvoice({...row, status: toStatus, version: nextVersion});
      this.remember(actor.tenant, operation, input.key, canonical, result);
      return result;
    });
  }

  pay(actor, input) {
    return this.transition(actor, input, 'pay', 'open', 'paid');
  }

  refund(actor, input) {
    return this.transition(actor, input, 'refund', 'paid', 'refunded');
  }

  get(actor, id) {
    authorize(actor);
    validateId(id);
    const row = this.db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM ${INVOICES} WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) fail('NOT_FOUND', 'Invoice not found');
    return publicInvoice(row);
  }

  list(actor, input) {
    authorize(actor);
    if (!hasExactKeys(input, ['page', 'pageSize'])
        || !safeInteger(input.page, 1)
        || !safeInteger(input.pageSize, 1)
        || input.pageSize > 50) {
      fail('VALIDATION', 'Invalid pagination');
    }
    const total = this.db.prepare(`
      SELECT COUNT(*) AS total FROM ${INVOICES} WHERE tenant = ?
    `).get(actor.tenant).total;
    const offset = (input.page - 1) * input.pageSize;
    if (!Number.isSafeInteger(offset) || offset >= total) return {items: [], total};
    const rows = this.db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM ${INVOICES}
      WHERE tenant = ?
      ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(actor.tenant, input.pageSize, offset);
    return {items: rows.map(publicInvoice), total};
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
