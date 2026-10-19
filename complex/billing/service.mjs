import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function captureExactObject(value, expectedKeys, label = 'input') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('VALIDATION', `${label} must be an object`);
  }
  let keys;
  let descriptors;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw failure('VALIDATION', `${label} is invalid`);
  }
  if (keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
    throw failure('VALIDATION', `${label} has invalid keys`);
  }
  const captured = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure('VALIDATION', `${label}.${key} must be a data property`);
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function requireNonemptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw failure('VALIDATION', `${label} must be a nonempty string`);
  }
}

function requireSafeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw failure('VALIDATION', `${label} must be a safe integer >= ${minimum}`);
  }
}

function authorize(actor, allowReader) {
  let captured;
  try {
    captured = captureExactObject(actor, ['tenant', 'role'], 'actor');
  } catch {
    throw failure('AUTH', 'invalid actor');
  }
  if (typeof captured.tenant !== 'string' || captured.tenant.length === 0 ||
      (captured.role !== 'admin' && captured.role !== 'reader')) {
    throw failure('AUTH', 'invalid actor');
  }
  if (!allowReader && captured.role !== 'admin') {
    throw failure('FORBIDDEN', 'reader may not mutate');
  }
  return captured;
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

export class BillingService {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_issue_9002_invoices (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        UNIQUE (tenant, reservation_id)
      );
      CREATE INDEX IF NOT EXISTS billing_issue_9002_tenant_sequence
        ON billing_issue_9002_invoices (tenant, sequence);
      CREATE TABLE IF NOT EXISTS billing_issue_9002_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
    `);
    this.findIdempotency = this.db.prepare(`
      SELECT canonical_input, result_json FROM billing_issue_9002_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `);
    this.insertIdempotency = this.db.prepare(`
      INSERT INTO billing_issue_9002_idempotency
        (tenant, operation, idempotency_key, canonical_input, result_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.findInvoice = this.db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_issue_9002_invoices WHERE tenant = ? AND id = ?
    `);
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* retain the original error */ }
      throw error;
    }
  }

  replay(tenant, operation, key, canonicalInput) {
    const record = this.findIdempotency.get(tenant, operation, key);
    if (!record) return undefined;
    if (record.canonical_input !== canonicalInput) {
      throw failure('CONFLICT', 'idempotency key was used with different input');
    }
    return JSON.parse(record.result_json);
  }

  remember(tenant, operation, key, canonicalInput, result) {
    this.insertIdempotency.run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  issue(actor, input) {
    const principal = authorize(actor, false);
    const captured = captureExactObject(input, ['key', 'event']);
    requireNonemptyString(captured.key, 'key');
    const event = captureExactObject(captured.event,
      ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version'], 'event');
    requireNonemptyString(event.id, 'event.id');
    requireNonemptyString(event.tenant, 'event.tenant');
    requireNonemptyString(event.sku, 'event.sku');
    requireSafeInteger(event.quantity, 1, 'event.quantity');
    requireSafeInteger(event.amountCents, 0, 'event.amountCents');
    requireSafeInteger(event.version, 1, 'event.version');
    if (event.status !== 'reserved') throw failure('VALIDATION', 'event.status must be reserved');
    if (event.tenant !== principal.tenant) {
      throw failure('FORBIDDEN', 'event belongs to another tenant');
    }

    const canonicalInput = JSON.stringify({ key: captured.key, event });
    return this.transaction(() => {
      const replayed = this.replay(principal.tenant, 'issue', captured.key, canonicalInput);
      if (replayed !== undefined) return replayed;
      const duplicate = this.db.prepare(`
        SELECT 1 FROM billing_issue_9002_invoices WHERE tenant = ? AND reservation_id = ?
      `).get(principal.tenant, event.id);
      if (duplicate) throw failure('CONFLICT', 'reservation already has an invoice');

      const result = {
        id: randomUUID(), tenant: principal.tenant, reservationId: event.id,
        amountCents: event.amountCents, status: 'open', version: 1,
      };
      this.db.prepare(`
        INSERT INTO billing_issue_9002_invoices
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, 'open', 1)
      `).run(result.id, result.tenant, result.reservationId, result.amountCents);
      this.remember(principal.tenant, 'issue', captured.key, canonicalInput, result);
      return { ...result };
    });
  }

  pay(actor, input) {
    return this.transition(actor, input, 'pay', 'open', 'paid');
  }

  refund(actor, input) {
    return this.transition(actor, input, 'refund', 'paid', 'refunded');
  }

  transition(actor, input, operation, fromStatus, toStatus) {
    const principal = authorize(actor, false);
    const captured = captureExactObject(input, ['key', 'id', 'expectedVersion']);
    requireNonemptyString(captured.key, 'key');
    requireNonemptyString(captured.id, 'id');
    requireSafeInteger(captured.expectedVersion, 1, 'expectedVersion');
    const canonicalInput = JSON.stringify(captured);
    return this.transaction(() => {
      const replayed = this.replay(principal.tenant, operation, captured.key, canonicalInput);
      if (replayed !== undefined) return replayed;
      const row = this.findInvoice.get(principal.tenant, captured.id);
      if (!row) throw failure('NOT_FOUND', 'invoice not found');
      if (row.version !== captured.expectedVersion || row.status !== fromStatus) {
        throw failure('CONFLICT', 'invoice state or version does not match');
      }
      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) throw failure('VALIDATION', 'invoice version is unsafe');
      this.db.prepare(`
        UPDATE billing_issue_9002_invoices SET status = ?, version = ?
        WHERE tenant = ? AND id = ?
      `).run(toStatus, nextVersion, principal.tenant, captured.id);
      const result = {
        id: row.id, tenant: row.tenant, reservationId: row.reservation_id,
        amountCents: row.amount_cents, status: toStatus, version: nextVersion,
      };
      this.remember(principal.tenant, operation, captured.key, canonicalInput, result);
      return { ...result };
    });
  }

  get(actor, id) {
    const principal = authorize(actor, true);
    requireNonemptyString(id, 'id');
    const row = this.findInvoice.get(principal.tenant, id);
    if (!row) throw failure('NOT_FOUND', 'invoice not found');
    return invoiceFromRow(row);
  }

  list(actor, input) {
    const principal = authorize(actor, true);
    const captured = captureExactObject(input, ['page', 'pageSize']);
    requireSafeInteger(captured.page, 1, 'page');
    requireSafeInteger(captured.pageSize, 1, 'pageSize');
    if (captured.pageSize > 50) throw failure('VALIDATION', 'pageSize must be <= 50');
    const count = this.db.prepare(`
      SELECT COUNT(*) AS total FROM billing_issue_9002_invoices WHERE tenant = ?
    `).get(principal.tenant);
    const offset = (captured.page - 1) * captured.pageSize;
    const rows = Number.isSafeInteger(offset) ? this.db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_issue_9002_invoices WHERE tenant = ? ORDER BY sequence LIMIT ? OFFSET ?
    `).all(principal.tenant, captured.pageSize, offset) : [];
    return { items: rows.map(invoiceFromRow), total: count.total };
  }

  close() {
    this.db.close();
  }
}
