import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

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
  return keys.length === expected.length && expected.every(key => keys.includes(key));
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function authorize(actor, mutation = false) {
  if (!hasExactKeys(actor, ['tenant', 'role'])
      || !nonemptyString(actor.tenant)
      || (actor.role !== 'admin' && actor.role !== 'reader')) {
    fail('AUTH', 'Invalid actor');
  }
  if (mutation && actor.role !== 'admin') {
    fail('FORBIDDEN', 'Actor may not mutate reservations');
  }
}

function reservationFromRow(row) {
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

function inventoryFromRow(row) {
  return {sku: row.sku, available: row.available, unitCents: row.unit_cents};
}

export class ReservationService {
  #database;
  #closed = false;

  constructor(filename) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS reservation_inventory (
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        available INTEGER NOT NULL,
        unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reservation_resources (
        creation_order INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reservation_resources_tenant_order
        ON reservation_resources (tenant, creation_order);
      CREATE TABLE IF NOT EXISTS reservation_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        original_result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      ) STRICT;
    `);
  }

  #transaction(work) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the operation's original error if SQLite already rolled back.
      }
      throw error;
    }
  }

  #replayOrConflict(tenant, operation, key, canonicalInput) {
    const row = this.#database.prepare(`
      SELECT canonical_input, original_result FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonicalInput) {
      fail('CONFLICT', 'Idempotency key was used with different input');
    }
    return JSON.parse(row.original_result);
  }

  #recordResult(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
      INSERT INTO reservation_idempotency
        (tenant, operation, idempotency_key, canonical_input, original_result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    authorize(actor, true);
    if (!hasExactKeys(input, ['sku', 'available', 'unitCents'])
        || !nonemptyString(input.sku)
        || !safeInteger(input.available)
        || !safeInteger(input.unitCents)) {
      fail('VALIDATION', 'Invalid inventory seed');
    }

    return this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, input.sku);
      if (existing) fail('CONFLICT', 'Inventory item already exists');
      this.#database.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(actor.tenant, input.sku, input.available, input.unitCents);
    });
  }

  reserve(actor, input) {
    authorize(actor, true);
    if (!hasExactKeys(input, ['key', 'sku', 'quantity'])
        || !nonemptyString(input.key)
        || !nonemptyString(input.sku)
        || !safeInteger(input.quantity, 1)) {
      fail('VALIDATION', 'Invalid reservation request');
    }
    const canonicalInput = JSON.stringify({key: input.key, sku: input.sku, quantity: input.quantity});

    return this.#transaction(() => {
      const replay = this.#replayOrConflict(actor.tenant, 'reserve', input.key, canonicalInput);
      if (replay !== undefined) return replay;
      const stock = this.#database.prepare(`
        SELECT available, unit_cents FROM reservation_inventory
        WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, input.sku);
      if (!stock) fail('NOT_FOUND', 'Inventory item not found');
      if (stock.available < input.quantity) fail('CONFLICT', 'Insufficient inventory');

      const amountCents = input.quantity * stock.unit_cents;
      if (!safeInteger(amountCents)) fail('VALIDATION', 'Reservation amount is unsafe');
      const result = {
        id: randomUUID(), tenant: actor.tenant, sku: input.sku, quantity: input.quantity,
        amountCents, status: 'reserved', version: 1,
      };
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(input.quantity, actor.tenant, input.sku);
      this.#database.prepare(`
        INSERT INTO reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, result.tenant, result.sku, result.quantity, result.amountCents);
      this.#recordResult(actor.tenant, 'reserve', input.key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    authorize(actor, true);
    if (!hasExactKeys(input, ['key', 'id', 'expectedVersion'])
        || !nonemptyString(input.key)
        || !nonemptyString(input.id)
        || !safeInteger(input.expectedVersion, 1)) {
      fail('VALIDATION', 'Invalid cancellation request');
    }
    const canonicalInput = JSON.stringify({key: input.key, id: input.id, expectedVersion: input.expectedVersion});

    return this.#transaction(() => {
      const replay = this.#replayOrConflict(actor.tenant, 'cancel', input.key, canonicalInput);
      if (replay !== undefined) return replay;
      const row = this.#database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_resources WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (!row) fail('NOT_FOUND', 'Reservation not found');
      if (row.version !== input.expectedVersion || row.status !== 'reserved') {
        fail('CONFLICT', 'Reservation cannot be canceled');
      }

      const result = reservationFromRow({...row, status: 'canceled', version: row.version + 1});
      this.#database.prepare(`
        UPDATE reservation_resources SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(actor.tenant, input.id);
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, actor.tenant, row.sku);
      this.#recordResult(actor.tenant, 'cancel', input.key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    authorize(actor);
    if (!nonemptyString(sku)) fail('VALIDATION', 'Invalid SKU');
    const row = this.#database.prepare(`
      SELECT sku, available, unit_cents FROM reservation_inventory
      WHERE tenant = ? AND sku = ?
    `).get(actor.tenant, sku);
    if (!row) fail('NOT_FOUND', 'Inventory item not found');
    return inventoryFromRow(row);
  }

  get(actor, id) {
    authorize(actor);
    if (!nonemptyString(id)) fail('VALIDATION', 'Invalid id');
    const row = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) fail('NOT_FOUND', 'Reservation not found');
    return reservationFromRow(row);
  }

  list(actor, input) {
    authorize(actor);
    if (!hasExactKeys(input, ['page', 'pageSize'])
        || !safeInteger(input.page, 1)
        || !safeInteger(input.pageSize, 1)
        || input.pageSize > 50) {
      fail('VALIDATION', 'Invalid pagination');
    }
    const total = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM reservation_resources WHERE tenant = ?
    `).get(actor.tenant).total;
    const offset = (input.page - 1) * input.pageSize;
    const rows = Number.isSafeInteger(offset)
      ? this.#database.prepare(`
          SELECT id, tenant, sku, quantity, amount_cents, status, version
          FROM reservation_resources WHERE tenant = ?
          ORDER BY creation_order LIMIT ? OFFSET ?
        `).all(actor.tenant, input.pageSize, offset)
      : [];
    return {items: rows.map(reservationFromRow), total};
  }

  close() {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
