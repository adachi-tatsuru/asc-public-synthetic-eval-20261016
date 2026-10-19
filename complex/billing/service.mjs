import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

const EVENT_KEYS = ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version', 'currency'];

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  throw error;
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function hasExactOwnKeys(obj, keys) {
  if (!isPlainRecord(obj)) return false;
  const ownKeys = Reflect.ownKeys(obj);
  if (ownKeys.length !== keys.length) return false;
  const expected = new Set(keys);
  return ownKeys.every((k) => typeof k === 'string' && expected.has(k));
}

function toPublicInvoice(row) {
  return Object.freeze({
    id: row.id,
    tenant: row.tenant,
    reservationId: row.reservation_id,
    amountCents: row.amount_cents,
    status: row.status,
    version: row.version,
  });
}

export class BillingService {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_invoices (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        UNIQUE(tenant, reservation_id)
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        key TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, key)
      );
    `);
  }

  close() {
    this.db.close();
  }

  #checkActor(actor) {
    if (!isPlainRecord(actor)) fail('AUTH', 'invalid actor');
    const {tenant, role} = actor;
    if (!isNonEmptyString(tenant)) fail('AUTH', 'invalid tenant');
    if (role !== 'admin' && role !== 'reader') fail('AUTH', 'invalid role');
    return {tenant, role};
  }

  #checkWriter(actor) {
    const resolved = this.#checkActor(actor);
    if (resolved.role !== 'admin') fail('FORBIDDEN', 'reader cannot mutate');
    return resolved;
  }

  #runInTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE;');
    let result;
    try {
      result = fn();
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* ignore */ }
      throw error;
    }
    this.db.exec('COMMIT;');
    return result;
  }

  #findIdempotent(tenant, operation, key) {
    return this.db
      .prepare('SELECT input_json, result_json FROM billing_idempotency WHERE tenant = ? AND operation = ? AND key = ?')
      .get(tenant, operation, key);
  }

  #storeIdempotent(tenant, operation, key, inputJson, resultJson) {
    this.db
      .prepare('INSERT INTO billing_idempotency (tenant, operation, key, input_json, result_json) VALUES (?, ?, ?, ?, ?)')
      .run(tenant, operation, key, inputJson, resultJson);
  }

  issue(actor, input) {
    const writer = this.#checkWriter(actor);

    if (!hasExactOwnKeys(input, ['key', 'event'])) fail('VALIDATION', 'invalid issue input');
    const {key, event} = input;
    if (!isNonEmptyString(key)) fail('VALIDATION', 'invalid idempotency key');
    if (!isPlainRecord(event)) fail('VALIDATION', 'invalid event');
    if (!hasExactOwnKeys(event, EVENT_KEYS)) fail('VALIDATION', 'invalid event shape');

    // Read each property exactly once; validate and persist the same local values.
    const {
      id: reservationId,
      tenant: eventTenant,
      sku,
      quantity,
      amountCents,
      status,
      version,
      currency,
    } = event;

    if (!isNonEmptyString(reservationId)) fail('VALIDATION', 'invalid event id');
    if (!isNonEmptyString(eventTenant)) fail('VALIDATION', 'invalid event tenant');
    if (!isNonEmptyString(sku)) fail('VALIDATION', 'invalid event sku');
    if (!isSafeInt(quantity) || quantity <= 0) fail('VALIDATION', 'invalid quantity');
    if (!isSafeInt(amountCents) || amountCents < 0) fail('VALIDATION', 'invalid amountCents');
    if (status !== 'reserved') fail('VALIDATION', 'invalid status');
    if (!isSafeInt(version) || version < 1) fail('VALIDATION', 'invalid version');
    if (currency !== 'JPY') fail('VALIDATION', 'invalid currency');

    if (eventTenant !== writer.tenant) fail('FORBIDDEN', 'event tenant mismatch');

    return this.#runInTransaction(() => {
      const canonicalInput = JSON.stringify({
        id: reservationId,
        tenant: eventTenant,
        sku,
        quantity,
        amountCents,
        status,
        version,
        currency,
      });

      const existing = this.#findIdempotent(writer.tenant, 'issue', key);
      if (existing) {
        if (existing.input_json !== canonicalInput) fail('CONFLICT', 'idempotency key reused with different input');
        return Object.freeze(JSON.parse(existing.result_json));
      }

      const priorInvoice = this.db
        .prepare('SELECT id FROM billing_invoices WHERE tenant = ? AND reservation_id = ?')
        .get(writer.tenant, reservationId);
      if (priorInvoice) fail('CONFLICT', 'invoice already issued for reservation');

      const id = randomUUID();
      this.db
        .prepare('INSERT INTO billing_invoices (id, tenant, reservation_id, amount_cents, status, version) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, writer.tenant, reservationId, amountCents, 'open', 1);

      const result = Object.freeze({
        id,
        tenant: writer.tenant,
        reservationId,
        amountCents,
        status: 'open',
        version: 1,
      });

      this.#storeIdempotent(writer.tenant, 'issue', key, canonicalInput, JSON.stringify(result));
      return result;
    });
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    const writer = this.#checkWriter(actor);

    if (!hasExactOwnKeys(input, ['key', 'id', 'expectedVersion'])) fail('VALIDATION', `invalid ${operation} input`);
    const {key, id, expectedVersion} = input;
    if (!isNonEmptyString(key)) fail('VALIDATION', 'invalid idempotency key');
    if (!isNonEmptyString(id)) fail('VALIDATION', 'invalid id');
    if (!isSafeInt(expectedVersion) || expectedVersion < 1) fail('VALIDATION', 'invalid expectedVersion');

    return this.#runInTransaction(() => {
      const canonicalInput = JSON.stringify({id, expectedVersion});

      const existing = this.#findIdempotent(writer.tenant, operation, key);
      if (existing) {
        if (existing.input_json !== canonicalInput) fail('CONFLICT', 'idempotency key reused with different input');
        return Object.freeze(JSON.parse(existing.result_json));
      }

      const row = this.db
        .prepare('SELECT * FROM billing_invoices WHERE tenant = ? AND id = ?')
        .get(writer.tenant, id);
      if (!row) fail('NOT_FOUND', 'invoice not found');
      if (row.status !== fromStatus || row.version !== expectedVersion) fail('CONFLICT', 'stale version or invalid state');

      const newVersion = row.version + 1;
      this.db
        .prepare('UPDATE billing_invoices SET status = ?, version = ? WHERE id = ?')
        .run(toStatus, newVersion, row.id);

      const result = Object.freeze({
        id: row.id,
        tenant: row.tenant,
        reservationId: row.reservation_id,
        amountCents: row.amount_cents,
        status: toStatus,
        version: newVersion,
      });

      this.#storeIdempotent(writer.tenant, operation, key, canonicalInput, JSON.stringify(result));
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
    const reader = this.#checkActor(actor);
    if (!isNonEmptyString(id)) fail('VALIDATION', 'invalid id');
    const row = this.db
      .prepare('SELECT * FROM billing_invoices WHERE tenant = ? AND id = ?')
      .get(reader.tenant, id);
    if (!row) fail('NOT_FOUND', 'invoice not found');
    return toPublicInvoice(row);
  }

  list(actor, input) {
    const reader = this.#checkActor(actor);
    if (!hasExactOwnKeys(input, ['page', 'pageSize'])) fail('VALIDATION', 'invalid list input');
    const {page, pageSize} = input;
    if (!isSafeInt(page) || page < 1) fail('VALIDATION', 'invalid page');
    if (!isSafeInt(pageSize) || pageSize < 1 || pageSize > 50) fail('VALIDATION', 'invalid pageSize');

    const totalRow = this.db
      .prepare('SELECT COUNT(*) AS c FROM billing_invoices WHERE tenant = ?')
      .get(reader.tenant);
    const total = totalRow.c;

    const rows = this.db
      .prepare('SELECT * FROM billing_invoices WHERE tenant = ? ORDER BY seq ASC LIMIT ? OFFSET ?')
      .all(reader.tenant, pageSize, (page - 1) * pageSize);

    return {items: rows.map(toPublicInvoice), total};
  }
}
