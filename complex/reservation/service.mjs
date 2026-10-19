import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object') return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length && expected.every(key => actual.includes(key));
}

function requireExact(value, expected) {
  if (!hasExactKeys(value, expected)) throw failure('VALIDATION', 'Invalid input');
}

function requireNonemptyString(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw failure('VALIDATION', 'Expected a nonempty string');
  }
}

function requireSafeInteger(value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw failure('VALIDATION', 'Expected a safe integer');
  }
}

function authorize(actor, mutation = false) {
  if (!hasExactKeys(actor, ['tenant', 'role']) ||
      typeof actor.tenant !== 'string' || actor.tenant.length === 0 ||
      (actor.role !== 'admin' && actor.role !== 'reader')) {
    throw failure('AUTH', 'Invalid actor');
  }
  if (mutation && actor.role !== 'admin') throw failure('FORBIDDEN', 'Mutation is forbidden');
  return actor.tenant;
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
  #db;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
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
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      ) STRICT;
    `);
  }

  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Preserve the operation's original error if rollback itself fails.
      }
      throw error;
    }
  }

  #replay(tenant, operation, key, canonicalInput) {
    const row = this.#db.prepare(`
      SELECT canonical_input, result
      FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonicalInput) {
      throw failure('CONFLICT', 'Idempotency key was used with different input');
    }
    return JSON.parse(row.result);
  }

  #record(tenant, operation, key, canonicalInput, result) {
    this.#db.prepare(`
      INSERT INTO reservation_idempotency
        (tenant, operation, idempotency_key, canonical_input, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    const tenant = authorize(actor, true);
    requireExact(input, ['sku', 'available', 'unitCents']);
    requireNonemptyString(input.sku);
    requireSafeInteger(input.available, 0);
    requireSafeInteger(input.unitCents, 0);

    return this.#transaction(() => {
      const existing = this.#db.prepare(`
        SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(tenant, input.sku);
      if (existing) throw failure('CONFLICT', 'SKU already exists');
      this.#db.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(tenant, input.sku, input.available, input.unitCents);
      return undefined;
    });
  }

  reserve(actor, input) {
    const tenant = authorize(actor, true);
    requireExact(input, ['key', 'sku', 'quantity']);
    requireNonemptyString(input.key);
    requireNonemptyString(input.sku);
    requireSafeInteger(input.quantity, 1);
    const canonicalInput = JSON.stringify([input.sku, input.quantity]);

    return this.#transaction(() => {
      const replay = this.#replay(tenant, 'reserve', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const inventory = this.#db.prepare(`
        SELECT available, unit_cents
        FROM reservation_inventory
        WHERE tenant = ? AND sku = ?
      `).get(tenant, input.sku);
      if (!inventory) throw failure('NOT_FOUND', 'SKU not found');
      if (inventory.available < input.quantity) throw failure('CONFLICT', 'Insufficient inventory');
      const amountCents = inventory.unit_cents * input.quantity;
      if (!Number.isSafeInteger(amountCents)) throw failure('VALIDATION', 'Amount is unsafe');

      const result = {
        id: randomUUID(),
        tenant,
        sku: input.sku,
        quantity: input.quantity,
        amountCents,
        status: 'reserved',
        version: 1,
      };
      this.#db.prepare(`
        UPDATE reservation_inventory
        SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(input.quantity, tenant, input.sku);
      this.#db.prepare(`
        INSERT INTO reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, tenant, input.sku, input.quantity, amountCents);
      this.#record(tenant, 'reserve', input.key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    const tenant = authorize(actor, true);
    requireExact(input, ['key', 'id', 'expectedVersion']);
    requireNonemptyString(input.key);
    requireNonemptyString(input.id);
    requireSafeInteger(input.expectedVersion, 1);
    const canonicalInput = JSON.stringify([input.id, input.expectedVersion]);

    return this.#transaction(() => {
      const replay = this.#replay(tenant, 'cancel', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.#db.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_resources
        WHERE tenant = ? AND id = ?
      `).get(tenant, input.id);
      if (!row) throw failure('NOT_FOUND', 'Reservation not found');
      if (row.version !== input.expectedVersion || row.status !== 'reserved') {
        throw failure('CONFLICT', 'Reservation cannot be canceled');
      }

      const changed = this.#db.prepare(`
        UPDATE reservation_resources
        SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ? AND version = ? AND status = 'reserved'
      `).run(tenant, input.id, input.expectedVersion);
      if (changed.changes !== 1) throw failure('CONFLICT', 'Reservation changed concurrently');
      this.#db.prepare(`
        UPDATE reservation_inventory
        SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, tenant, row.sku);
      const result = {...publicReservation(row), status: 'canceled', version: row.version + 1};
      this.#record(tenant, 'cancel', input.key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    const tenant = authorize(actor);
    requireNonemptyString(sku);
    const row = this.#db.prepare(`
      SELECT sku, available, unit_cents
      FROM reservation_inventory
      WHERE tenant = ? AND sku = ?
    `).get(tenant, sku);
    if (!row) throw failure('NOT_FOUND', 'SKU not found');
    return {sku: row.sku, available: row.available, unitCents: row.unit_cents};
  }

  get(actor, id) {
    const tenant = authorize(actor);
    requireNonemptyString(id);
    const row = this.#db.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources
      WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (!row) throw failure('NOT_FOUND', 'Reservation not found');
    return publicReservation(row);
  }

  list(actor, input) {
    const tenant = authorize(actor);
    requireExact(input, ['page', 'pageSize']);
    requireSafeInteger(input.page, 1);
    requireSafeInteger(input.pageSize, 1);
    if (input.pageSize > 50) throw failure('VALIDATION', 'Page size is too large');

    const {total} = this.#db.prepare(`
      SELECT count(*) AS total FROM reservation_resources WHERE tenant = ?
    `).get(tenant);
    if (total === 0 || input.page - 1 >= Math.ceil(total / input.pageSize)) {
      return {items: [], total};
    }
    const offset = (input.page - 1) * input.pageSize;
    const rows = this.#db.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources
      WHERE tenant = ?
      ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(tenant, input.pageSize, offset);
    return {items: rows.map(publicReservation), total};
  }

  close() {
    this.#db.close();
  }
}
