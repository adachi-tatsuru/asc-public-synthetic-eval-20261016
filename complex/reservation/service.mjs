import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function hasExactly(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => typeof key === 'string' && expectedKeys.includes(key));
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateActor(actor, mutation) {
  if (!hasExactly(actor, ['tenant', 'role'])
      || !nonemptyString(actor.tenant)
      || (actor.role !== 'admin' && actor.role !== 'reader')) fail('AUTH');
  if (mutation && actor.role !== 'admin') fail('FORBIDDEN');
}

function publicReservation(row) {
  return {
    id: row.id,
    tenant: row.tenant,
    sku: row.sku,
    quantity: row.quantity,
    amountCents: row.amount_cents,
    status: row.status,
    version: row.version,
  };
}

export class ReservationService {
  #database;
  #closed = false;

  constructor(filename) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reservation_r9001_inventory (
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        available INTEGER NOT NULL,
        unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reservation_r9001_records (
        creation_order INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reservation_r9001_records_tenant_order
        ON reservation_r9001_records (tenant, creation_order);
      CREATE TABLE IF NOT EXISTS reservation_r9001_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      ) STRICT;
    `);
  }

  #transaction(operation) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  #replay(tenant, operation, key, canonicalInput) {
    const row = this.#database.prepare(`
      SELECT input_json, result_json FROM reservation_r9001_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (row === undefined) return undefined;
    if (row.input_json !== canonicalInput) fail('CONFLICT');
    return JSON.parse(row.result_json);
  }

  #remember(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
      INSERT INTO reservation_r9001_idempotency
        (tenant, operation, idempotency_key, input_json, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    validateActor(actor, true);
    if (!hasExactly(input, ['sku', 'available', 'unitCents'])
        || !nonemptyString(input.sku)
        || !safeInteger(input.available, 0)
        || !safeInteger(input.unitCents, 0)) fail('VALIDATION');

    this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT 1 FROM reservation_r9001_inventory WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, input.sku);
      if (existing !== undefined) fail('CONFLICT');
      this.#database.prepare(`
        INSERT INTO reservation_r9001_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(actor.tenant, input.sku, input.available, input.unitCents);
    });
  }

  reserve(actor, input) {
    validateActor(actor, true);
    if (!hasExactly(input, ['key', 'sku', 'quantity'])
        || !nonemptyString(input.key)
        || !nonemptyString(input.sku)
        || !safeInteger(input.quantity, 1)) fail('VALIDATION');
    const canonicalInput = JSON.stringify({ sku: input.sku, quantity: input.quantity });

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, 'reserve', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const inventory = this.#database.prepare(`
        SELECT available, unit_cents FROM reservation_r9001_inventory
        WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, input.sku);
      if (inventory === undefined) fail('NOT_FOUND');
      if (inventory.available < input.quantity) fail('CONFLICT');
      const amountCents = inventory.unit_cents * input.quantity;
      if (!Number.isSafeInteger(amountCents)) fail('VALIDATION');

      const result = {
        id: randomUUID(), tenant: actor.tenant, sku: input.sku,
        quantity: input.quantity, amountCents, status: 'reserved', version: 1,
      };
      this.#database.prepare(`
        UPDATE reservation_r9001_inventory SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(input.quantity, actor.tenant, input.sku);
      this.#database.prepare(`
        INSERT INTO reservation_r9001_records
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(result.id, result.tenant, result.sku, result.quantity,
        result.amountCents, result.status, result.version);
      this.#remember(actor.tenant, 'reserve', input.key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    validateActor(actor, true);
    if (!hasExactly(input, ['key', 'id', 'expectedVersion'])
        || !nonemptyString(input.key)
        || !nonemptyString(input.id)
        || !safeInteger(input.expectedVersion, 1)) fail('VALIDATION');
    const canonicalInput = JSON.stringify({ id: input.id, expectedVersion: input.expectedVersion });

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, 'cancel', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.#database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_r9001_records WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (row === undefined) fail('NOT_FOUND');
      if (row.version !== input.expectedVersion || row.status !== 'reserved') fail('CONFLICT');

      this.#database.prepare(`
        UPDATE reservation_r9001_records SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(actor.tenant, input.id);
      this.#database.prepare(`
        UPDATE reservation_r9001_inventory SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, actor.tenant, row.sku);
      const result = {
        id: row.id, tenant: row.tenant, sku: row.sku, quantity: row.quantity,
        amountCents: row.amount_cents, status: 'canceled', version: row.version + 1,
      };
      this.#remember(actor.tenant, 'cancel', input.key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    validateActor(actor, false);
    if (!nonemptyString(sku)) fail('VALIDATION');
    const row = this.#database.prepare(`
      SELECT sku, available, unit_cents FROM reservation_r9001_inventory
      WHERE tenant = ? AND sku = ?
    `).get(actor.tenant, sku);
    if (row === undefined) fail('NOT_FOUND');
    return { sku: row.sku, available: row.available, unitCents: row.unit_cents };
  }

  get(actor, id) {
    validateActor(actor, false);
    if (!nonemptyString(id)) fail('VALIDATION');
    const row = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_r9001_records WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (row === undefined) fail('NOT_FOUND');
    return publicReservation(row);
  }

  list(actor, input) {
    validateActor(actor, false);
    if (!hasExactly(input, ['page', 'pageSize'])
        || !safeInteger(input.page, 1)
        || !safeInteger(input.pageSize, 1)
        || input.pageSize > 50) fail('VALIDATION');

    const total = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM reservation_r9001_records WHERE tenant = ?
    `).get(actor.tenant).total;
    const offset = (input.page - 1) * input.pageSize;
    if (!Number.isSafeInteger(offset) || offset >= total) return { items: [], total };
    const rows = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_r9001_records WHERE tenant = ?
      ORDER BY creation_order LIMIT ? OFFSET ?
    `).all(actor.tenant, input.pageSize, offset);
    return { items: rows.map(publicReservation), total };
  }

  close() {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }
}
