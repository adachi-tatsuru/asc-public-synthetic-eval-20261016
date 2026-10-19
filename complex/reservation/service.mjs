import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length && expected.every(key => actual.includes(key));
}

function requireActor(actor) {
  if (!hasExactKeys(actor, ['tenant', 'role']) ||
      typeof actor.tenant !== 'string' || actor.tenant.length === 0 ||
      (actor.role !== 'admin' && actor.role !== 'reader')) {
    throw serviceError('AUTH', 'Invalid actor');
  }
}

function requireAdmin(actor) {
  requireActor(actor);
  if (actor.role !== 'admin') throw serviceError('FORBIDDEN', 'Mutation is not allowed');
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateInput(input, keys, fields) {
  if (!hasExactKeys(input, keys) || !fields(input)) {
    throw serviceError('VALIDATION', 'Invalid input');
  }
}

function publicReservation(row) {
  return Object.freeze({
    id: row.id,
    tenant: row.tenant,
    sku: row.sku,
    quantity: row.quantity,
    amountCents: row.amount_cents,
    status: row.status,
    version: row.version,
  });
}

function replayResult(row, canonicalInput) {
  if (row.input !== canonicalInput) {
    throw serviceError('CONFLICT', 'Idempotency key was used with different input');
  }
  return Object.freeze(JSON.parse(row.result));
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
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reservation_resources_tenant_sequence
        ON reservation_resources (tenant, sequence);
      CREATE TABLE IF NOT EXISTS reservation_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        key TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, key)
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
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the business or SQLite error that caused the rollback.
      }
      throw error;
    }
  }

  #findReplay(tenant, operation, key, canonicalInput) {
    const row = this.#database.prepare(`
      SELECT input, result FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND key = ?
    `).get(tenant, operation, key);
    return row === undefined ? undefined : replayResult(row, canonicalInput);
  }

  #record(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
      INSERT INTO reservation_idempotency (tenant, operation, key, input, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    requireAdmin(actor);
    validateInput(input, ['sku', 'available', 'unitCents'], value =>
      nonemptyString(value.sku) && safeInteger(value.available, 0) &&
      safeInteger(value.unitCents, 0));

    return this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, input.sku);
      if (existing !== undefined) throw serviceError('CONFLICT', 'SKU already exists');
      this.#database.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(actor.tenant, input.sku, input.available, input.unitCents);
    });
  }

  reserve(actor, input) {
    requireAdmin(actor);
    validateInput(input, ['key', 'sku', 'quantity'], value =>
      nonemptyString(value.key) && nonemptyString(value.sku) && safeInteger(value.quantity, 1));
    const canonicalInput = JSON.stringify([input.sku, input.quantity]);

    return this.#transaction(() => {
      const replay = this.#findReplay(actor.tenant, 'reserve', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const inventory = this.#database.prepare(`
        SELECT available, unit_cents FROM reservation_inventory
        WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, input.sku);
      if (inventory === undefined) throw serviceError('NOT_FOUND', 'SKU not found');
      if (inventory.available < input.quantity) {
        throw serviceError('CONFLICT', 'Insufficient inventory');
      }
      const amountCents = inventory.unit_cents * input.quantity;
      if (!Number.isSafeInteger(amountCents)) {
        throw serviceError('VALIDATION', 'Reservation amount is outside the safe integer range');
      }

      const result = Object.freeze({
        id: randomUUID(),
        tenant: actor.tenant,
        sku: input.sku,
        quantity: input.quantity,
        amountCents,
        status: 'reserved',
        version: 1,
      });
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(input.quantity, actor.tenant, input.sku);
      this.#database.prepare(`
        INSERT INTO reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, result.tenant, result.sku, result.quantity, result.amountCents);
      this.#record(actor.tenant, 'reserve', input.key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    requireAdmin(actor);
    validateInput(input, ['key', 'id', 'expectedVersion'], value =>
      nonemptyString(value.key) && nonemptyString(value.id) && safeInteger(value.expectedVersion, 1));
    const canonicalInput = JSON.stringify([input.id, input.expectedVersion]);

    return this.#transaction(() => {
      const replay = this.#findReplay(actor.tenant, 'cancel', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.#database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_resources WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (row === undefined) throw serviceError('NOT_FOUND', 'Reservation not found');
      if (row.version !== input.expectedVersion || row.status !== 'reserved') {
        throw serviceError('CONFLICT', 'Reservation cannot be canceled');
      }

      this.#database.prepare(`
        UPDATE reservation_resources SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(actor.tenant, input.id);
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, actor.tenant, row.sku);
      row.status = 'canceled';
      row.version += 1;
      const result = publicReservation(row);
      this.#record(actor.tenant, 'cancel', input.key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    requireActor(actor);
    if (!nonemptyString(sku)) throw serviceError('VALIDATION', 'Invalid SKU');
    const row = this.#database.prepare(`
      SELECT sku, available, unit_cents FROM reservation_inventory
      WHERE tenant = ? AND sku = ?
    `).get(actor.tenant, sku);
    if (row === undefined) throw serviceError('NOT_FOUND', 'SKU not found');
    return Object.freeze({sku: row.sku, available: row.available, unitCents: row.unit_cents});
  }

  get(actor, id) {
    requireActor(actor);
    if (!nonemptyString(id)) throw serviceError('VALIDATION', 'Invalid reservation ID');
    const row = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (row === undefined) throw serviceError('NOT_FOUND', 'Reservation not found');
    return publicReservation(row);
  }

  list(actor, input) {
    requireActor(actor);
    validateInput(input, ['page', 'pageSize'], value =>
      safeInteger(value.page, 1) && safeInteger(value.pageSize, 1) && value.pageSize <= 50);
    const total = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM reservation_resources WHERE tenant = ?
    `).get(actor.tenant).total;
    const offset = (input.page - 1) * input.pageSize;
    const rows = Number.isSafeInteger(offset) ? this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources WHERE tenant = ?
      ORDER BY sequence LIMIT ? OFFSET ?
    `).all(actor.tenant, input.pageSize, offset) : [];
    return Object.freeze({items: Object.freeze(rows.map(publicReservation)), total});
  }

  close() {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }
}
