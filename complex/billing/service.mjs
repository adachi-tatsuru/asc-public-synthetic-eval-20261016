import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const ownKeysAre = (value, expected) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every(key => keys.includes(key));
};

const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const nonemptyString = value => typeof value === 'string' && value.length > 0;
const safeInteger = value => Number.isSafeInteger(value);

function authorize(actor, mutate = false) {
  if (!ownKeysAre(actor, ['tenant', 'role']) || !nonemptyString(actor.tenant) ||
      (actor.role !== 'admin' && actor.role !== 'reader')) {
    fail('AUTH', 'Invalid actor');
  }
  if (mutate && actor.role !== 'admin') fail('FORBIDDEN', 'Mutation requires an admin');
}

function validateId(id) {
  if (!nonemptyString(id)) fail('VALIDATION', 'Invalid id');
}

function validateMutation(input) {
  if (!ownKeysAre(input, ['key', 'id', 'expectedVersion']) ||
      !nonemptyString(input.key) || !nonemptyString(input.id) ||
      !safeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    fail('VALIDATION', 'Invalid mutation input');
  }
  return {
    key: input.key,
    id: input.id,
    expectedVersion: input.expectedVersion,
  };
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
  #db;

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

  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #replay(tenant, operation, key, inputJson) {
    const row = this.#db.prepare(`
      SELECT input_json, result_json
      FROM billing_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.input_json !== inputJson) fail('CONFLICT', 'Idempotency key was reused');
    return JSON.parse(row.result_json);
  }

  #remember(tenant, operation, key, inputJson, result) {
    this.#db.prepare(`
      INSERT INTO billing_idempotency
        (tenant, operation, idempotency_key, input_json, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, inputJson, JSON.stringify(result));
  }

  issue(actor, input) {
    authorize(actor, true);
    if (!ownKeysAre(input, ['key', 'event']) || !nonemptyString(input.key) ||
        !ownKeysAre(input.event, ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version'])) {
      fail('VALIDATION', 'Invalid issue input');
    }

    const event = input.event;
    if (!nonemptyString(event.id) || !nonemptyString(event.tenant) || !nonemptyString(event.sku) ||
        !safeInteger(event.quantity) || event.quantity < 1 ||
        !safeInteger(event.amountCents) || event.amountCents < 0 ||
        event.status !== 'reserved' || !safeInteger(event.version) || event.version < 1) {
      fail('VALIDATION', 'Invalid reservation event');
    }
    if (event.tenant !== actor.tenant) fail('FORBIDDEN', 'Reservation belongs to another tenant');

    const canonical = JSON.stringify({
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

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, 'issue', input.key, canonical);
      if (replay !== undefined) return replay;

      const duplicate = this.#db.prepare(`
        SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, event.id);
      if (duplicate) fail('CONFLICT', 'Reservation already has an invoice');

      const result = {
        id: randomUUID(),
        tenant: actor.tenant,
        reservationId: event.id,
        amountCents: event.amountCents,
        status: 'open',
        version: 1,
      };
      this.#db.prepare(`
        INSERT INTO billing_invoices
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, 'open', 1)
      `).run(result.id, result.tenant, result.reservationId, result.amountCents);
      this.#remember(actor.tenant, 'issue', input.key, canonical, result);
      return result;
    });
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    authorize(actor, true);
    const value = validateMutation(input);
    const canonical = JSON.stringify(value);

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, operation, value.key, canonical);
      if (replay !== undefined) return replay;

      const row = this.#db.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices WHERE tenant = ? AND id = ?
      `).get(actor.tenant, value.id);
      if (!row) fail('NOT_FOUND', 'Invoice not found');
      if (row.version !== value.expectedVersion || row.status !== fromStatus) {
        fail('CONFLICT', 'Invoice state does not permit this transition');
      }

      const nextVersion = row.version + 1;
      if (!safeInteger(nextVersion)) fail('VALIDATION', 'Invoice version is too large');
      this.#db.prepare(`
        UPDATE billing_invoices SET status = ?, version = ?
        WHERE tenant = ? AND id = ? AND status = ? AND version = ?
      `).run(toStatus, nextVersion, actor.tenant, value.id, fromStatus, row.version);
      const result = invoiceFromRow({...row, status: toStatus, version: nextVersion});
      this.#remember(actor.tenant, operation, value.key, canonical, result);
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
      FROM billing_invoices WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) fail('NOT_FOUND', 'Invoice not found');
    return invoiceFromRow(row);
  }

  list(actor, query) {
    authorize(actor);
    if (!ownKeysAre(query, ['page', 'pageSize']) ||
        !safeInteger(query.page) || query.page < 1 ||
        !safeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 50) {
      fail('VALIDATION', 'Invalid pagination');
    }

    const count = this.#db.prepare(`
      SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?
    `).get(actor.tenant).total;
    if (query.page > Math.ceil(count / query.pageSize)) return {items: [], total: count};

    const offset = (query.page - 1) * query.pageSize;
    const rows = this.#db.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices
      WHERE tenant = ?
      ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(actor.tenant, query.pageSize, offset);
    return {items: rows.map(invoiceFromRow), total: count};
  }

  close() {
    this.#db.close();
  }
}
