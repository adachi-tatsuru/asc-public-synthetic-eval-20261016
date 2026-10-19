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

function readExactFields(value, expected, code = 'VALIDATION', message = 'Invalid input') {
  try {
    if (!hasExactKeys(value, expected)) fail(code, message);
    return Object.fromEntries(expected.map((key) => [key, value[key]]));
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code, message);
  }
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function authorize(actor, mutation = false) {
  const { tenant, role } = readExactFields(
    actor, ['tenant', 'role'], 'AUTH', 'Invalid actor',
  );
  if (!nonemptyString(tenant) || (role !== 'admin' && role !== 'reader')) {
    fail('AUTH', 'Invalid actor');
  }
  if (mutation && role !== 'admin') fail('FORBIDDEN', 'Mutation requires admin');
  return { tenant, role };
}

function validateKey(key) {
  if (!nonemptyString(key)) fail('VALIDATION', 'Invalid idempotency key');
}

function validateId(id) {
  if (!nonemptyString(id)) fail('VALIDATION', 'Invalid id');
}

function validateTransitionInput(input) {
  const fields = readExactFields(
    input, ['key', 'id', 'expectedVersion'], 'VALIDATION', 'Invalid mutation input',
  );
  validateKey(fields.key);
  validateId(fields.id);
  if (!safeInteger(fields.expectedVersion, 1)) {
    fail('VALIDATION', 'Invalid expectedVersion');
  }
  return fields;
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

  replay(tenant, operation, key, canonical, legacyCanonical) {
    const row = this.db.prepare(`
      SELECT canonical_input, result
      FROM ${IDEMPOTENCY}
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonical && row.canonical_input !== legacyCanonical) {
      fail('CONFLICT', 'Idempotency key conflict');
    }
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
    const { tenant } = authorize(actor, true);
    const { key, event } = readExactFields(
      input, ['key', 'event'], 'VALIDATION', 'Invalid issue input',
    );
    validateKey(key);
    const eventFields = readExactFields(event, [
      'id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version', 'currency',
    ], 'VALIDATION', 'Invalid reservation event');
    if (!nonemptyString(eventFields.id)
        || !nonemptyString(eventFields.tenant)
        || !nonemptyString(eventFields.sku)
        || !safeInteger(eventFields.quantity, 1)
        || !safeInteger(eventFields.amountCents, 0)
        || eventFields.status !== 'reserved'
        || !safeInteger(eventFields.version, 1)
        || eventFields.currency !== 'JPY') {
      fail('VALIDATION', 'Invalid reservation event');
    }
    if (eventFields.tenant !== tenant) fail('FORBIDDEN', 'Event tenant mismatch');

    const canonical = JSON.stringify({
      event: {
        id: eventFields.id,
        tenant: eventFields.tenant,
        sku: eventFields.sku,
        quantity: eventFields.quantity,
        amountCents: eventFields.amountCents,
        status: eventFields.status,
        version: eventFields.version,
        currency: eventFields.currency,
      },
    });
    const legacyCanonical = JSON.stringify({
      event: {
        id: eventFields.id,
        tenant: eventFields.tenant,
        sku: eventFields.sku,
        quantity: eventFields.quantity,
        amountCents: eventFields.amountCents,
        status: eventFields.status,
        version: eventFields.version,
      },
    });
    return this.transaction(() => {
      const replay = this.replay(tenant, 'issue', key, canonical, legacyCanonical);
      if (replay !== undefined) return replay;
      const duplicate = this.db.prepare(`
        SELECT 1 FROM ${INVOICES} WHERE tenant = ? AND reservation_id = ?
      `).get(tenant, eventFields.id);
      if (duplicate) fail('CONFLICT', 'Reservation already invoiced');

      const invoice = {
        id: randomUUID(),
        tenant,
        reservationId: eventFields.id,
        amountCents: eventFields.amountCents,
        status: 'open',
        version: 1,
      };
      this.db.prepare(`
        INSERT INTO ${INVOICES}
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, 'open', 1)
      `).run(invoice.id, invoice.tenant, invoice.reservationId, invoice.amountCents);
      this.remember(tenant, 'issue', key, canonical, invoice);
      return invoice;
    });
  }

  transition(actor, input, operation, fromStatus, toStatus) {
    const { tenant } = authorize(actor, true);
    const { key, id, expectedVersion } = validateTransitionInput(input);
    const canonical = JSON.stringify({id, expectedVersion});
    return this.transaction(() => {
      const replay = this.replay(tenant, operation, key, canonical);
      if (replay !== undefined) return replay;
      const row = this.db.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM ${INVOICES} WHERE tenant = ? AND id = ?
      `).get(tenant, id);
      if (!row) fail('NOT_FOUND', 'Invoice not found');
      if (row.version !== expectedVersion || row.status !== fromStatus) {
        fail('CONFLICT', 'Invoice state conflict');
      }
      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) fail('VALIDATION', 'Invoice version overflow');
      this.db.prepare(`
        UPDATE ${INVOICES} SET status = ?, version = ?
        WHERE tenant = ? AND id = ?
      `).run(toStatus, nextVersion, tenant, id);
      const result = publicInvoice({...row, status: toStatus, version: nextVersion});
      this.remember(tenant, operation, key, canonical, result);
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
    const { tenant } = authorize(actor);
    validateId(id);
    const row = this.db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM ${INVOICES} WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (!row) fail('NOT_FOUND', 'Invoice not found');
    return publicInvoice(row);
  }

  list(actor, input) {
    const { tenant } = authorize(actor);
    const { page, pageSize } = readExactFields(
      input, ['page', 'pageSize'], 'VALIDATION', 'Invalid pagination',
    );
    if (!safeInteger(page, 1) || !safeInteger(pageSize, 1) || pageSize > 50) {
      fail('VALIDATION', 'Invalid pagination');
    }
    const total = this.db.prepare(`
      SELECT COUNT(*) AS total FROM ${INVOICES} WHERE tenant = ?
    `).get(tenant).total;
    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset) || offset >= total) return {items: [], total};
    const rows = this.db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM ${INVOICES}
      WHERE tenant = ?
      ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(tenant, pageSize, offset);
    return {items: rows.map(publicInvoice), total};
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
