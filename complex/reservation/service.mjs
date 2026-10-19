import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function captureExactObject(value, expectedKeys, code = 'VALIDATION') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  let keys;
  let descriptors;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) fail(code);
  const captured = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    captured[key] = descriptor.value;
  }
  return captured;
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateActor(actor, mutation) {
  const captured = captureExactObject(actor, ['tenant', 'role'], 'AUTH');
  if (!nonemptyString(captured.tenant)
      || (captured.role !== 'admin' && captured.role !== 'reader')) fail('AUTH');
  if (mutation && captured.role !== 'admin') fail('FORBIDDEN');
  return captured;
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
    const principal = validateActor(actor, true);
    const captured = captureExactObject(input, ['sku', 'available', 'unitCents']);
    if (!nonemptyString(captured.sku)
        || !safeInteger(captured.available, 0)
        || !safeInteger(captured.unitCents, 0)) fail('VALIDATION');

    this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT 1 FROM reservation_r9001_inventory WHERE tenant = ? AND sku = ?
      `).get(principal.tenant, captured.sku);
      if (existing !== undefined) fail('CONFLICT');
      this.#database.prepare(`
        INSERT INTO reservation_r9001_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(principal.tenant, captured.sku, captured.available, captured.unitCents);
    });
  }

  reserve(actor, input) {
    const principal = validateActor(actor, true);
    const captured = captureExactObject(input, ['key', 'sku', 'quantity']);
    if (!nonemptyString(captured.key)
        || !nonemptyString(captured.sku)
        || !safeInteger(captured.quantity, 1)) fail('VALIDATION');
    const canonicalInput = JSON.stringify({ sku: captured.sku, quantity: captured.quantity });

    return this.#transaction(() => {
      const replay = this.#replay(principal.tenant, 'reserve', captured.key, canonicalInput);
      if (replay !== undefined) return replay;

      const inventory = this.#database.prepare(`
        SELECT available, unit_cents FROM reservation_r9001_inventory
        WHERE tenant = ? AND sku = ?
      `).get(principal.tenant, captured.sku);
      if (inventory === undefined) fail('NOT_FOUND');
      if (inventory.available < captured.quantity) fail('CONFLICT');
      const amountCents = inventory.unit_cents * captured.quantity;
      if (!Number.isSafeInteger(amountCents)) fail('VALIDATION');

      const result = {
        id: randomUUID(), tenant: principal.tenant, sku: captured.sku,
        quantity: captured.quantity, amountCents, status: 'reserved', version: 1,
      };
      this.#database.prepare(`
        UPDATE reservation_r9001_inventory SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(captured.quantity, principal.tenant, captured.sku);
      this.#database.prepare(`
        INSERT INTO reservation_r9001_records
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(result.id, result.tenant, result.sku, result.quantity,
        result.amountCents, result.status, result.version);
      this.#remember(principal.tenant, 'reserve', captured.key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    const principal = validateActor(actor, true);
    const captured = captureExactObject(input, ['key', 'id', 'expectedVersion']);
    if (!nonemptyString(captured.key)
        || !nonemptyString(captured.id)
        || !safeInteger(captured.expectedVersion, 1)) fail('VALIDATION');
    const canonicalInput = JSON.stringify({ id: captured.id, expectedVersion: captured.expectedVersion });

    return this.#transaction(() => {
      const replay = this.#replay(principal.tenant, 'cancel', captured.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.#database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_r9001_records WHERE tenant = ? AND id = ?
      `).get(principal.tenant, captured.id);
      if (row === undefined) fail('NOT_FOUND');
      if (row.version !== captured.expectedVersion || row.status !== 'reserved') fail('CONFLICT');

      this.#database.prepare(`
        UPDATE reservation_r9001_records SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(principal.tenant, captured.id);
      this.#database.prepare(`
        UPDATE reservation_r9001_inventory SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, principal.tenant, row.sku);
      const result = {
        id: row.id, tenant: row.tenant, sku: row.sku, quantity: row.quantity,
        amountCents: row.amount_cents, status: 'canceled', version: row.version + 1,
      };
      this.#remember(principal.tenant, 'cancel', captured.key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    const principal = validateActor(actor, false);
    if (!nonemptyString(sku)) fail('VALIDATION');
    const row = this.#database.prepare(`
      SELECT sku, available, unit_cents FROM reservation_r9001_inventory
      WHERE tenant = ? AND sku = ?
    `).get(principal.tenant, sku);
    if (row === undefined) fail('NOT_FOUND');
    return { sku: row.sku, available: row.available, unitCents: row.unit_cents };
  }

  get(actor, id) {
    const principal = validateActor(actor, false);
    if (!nonemptyString(id)) fail('VALIDATION');
    const row = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_r9001_records WHERE tenant = ? AND id = ?
    `).get(principal.tenant, id);
    if (row === undefined) fail('NOT_FOUND');
    return publicReservation(row);
  }

  list(actor, input) {
    const principal = validateActor(actor, false);
    const captured = captureExactObject(input, ['page', 'pageSize']);
    if (!safeInteger(captured.page, 1)
        || !safeInteger(captured.pageSize, 1)
        || captured.pageSize > 50) fail('VALIDATION');

    const total = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM reservation_r9001_records WHERE tenant = ?
    `).get(principal.tenant).total;
    const offset = (captured.page - 1) * captured.pageSize;
    if (!Number.isSafeInteger(offset) || offset >= total) return { items: [], total };
    const rows = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_r9001_records WHERE tenant = ?
      ORDER BY creation_order LIMIT ? OFFSET ?
    `).all(principal.tenant, captured.pageSize, offset);
    return { items: rows.map(publicReservation), total };
  }

  close() {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }
}
