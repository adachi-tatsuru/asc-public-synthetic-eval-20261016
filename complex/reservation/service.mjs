import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every(key => typeof key === 'string' && expected.includes(key));
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
    throw failure('VALIDATION', 'Expected a bounded safe integer');
  }
}

function authorize(actor, mutation = false) {
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)
      || typeof actor.tenant !== 'string' || actor.tenant.length === 0
      || (actor.role !== 'admin' && actor.role !== 'reader')) {
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
  #database;
  #closed = false;

  constructor(filename) {
    this.#database = new DatabaseSync(filename, {timeout: 5000});
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS reservation_inventory (
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        available INTEGER NOT NULL,
        unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      );
      CREATE TABLE IF NOT EXISTS reservation_resources (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reservation_resources_tenant_sequence
        ON reservation_resources (tenant, sequence);
      CREATE TABLE IF NOT EXISTS reservation_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
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
        // Preserve the error which caused the transaction to fail.
      }
      throw error;
    }
  }

  #replay(tenant, operation, key, canonicalInput) {
    const row = this.#database.prepare(`
      SELECT canonical_input, result
      FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonicalInput) {
      throw failure('CONFLICT', 'Idempotency key has different input');
    }
    return JSON.parse(row.result);
  }

  #remember(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
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
      const existing = this.#database.prepare(`
        SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(tenant, input.sku);
      if (existing) throw failure('CONFLICT', 'SKU already exists');
      this.#database.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(tenant, input.sku, input.available, input.unitCents);
    });
  }

  reserve(actor, input) {
    const tenant = authorize(actor, true);
    requireExact(input, ['key', 'sku', 'quantity']);
    requireNonemptyString(input.key);
    requireNonemptyString(input.sku);
    requireSafeInteger(input.quantity, 1);
    const canonicalInput = JSON.stringify({sku: input.sku, quantity: input.quantity});

    return this.#transaction(() => {
      const replay = this.#replay(tenant, 'reserve', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const inventory = this.#database.prepare(`
        SELECT available, unit_cents
        FROM reservation_inventory
        WHERE tenant = ? AND sku = ?
      `).get(tenant, input.sku);
      if (!inventory) throw failure('NOT_FOUND', 'SKU was not found');
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
      this.#database.prepare(`
        UPDATE reservation_inventory
        SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(input.quantity, tenant, input.sku);
      this.#database.prepare(`
        INSERT INTO reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(result.id, tenant, result.sku, result.quantity, result.amountCents, result.status, result.version);
      this.#remember(tenant, 'reserve', input.key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    const tenant = authorize(actor, true);
    requireExact(input, ['key', 'id', 'expectedVersion']);
    requireNonemptyString(input.key);
    requireNonemptyString(input.id);
    requireSafeInteger(input.expectedVersion, 1);
    const canonicalInput = JSON.stringify({id: input.id, expectedVersion: input.expectedVersion});

    return this.#transaction(() => {
      const replay = this.#replay(tenant, 'cancel', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.#database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_resources
        WHERE tenant = ? AND id = ?
      `).get(tenant, input.id);
      if (!row) throw failure('NOT_FOUND', 'Reservation was not found');
      if (row.version !== input.expectedVersion || row.status !== 'reserved') {
        throw failure('CONFLICT', 'Reservation cannot be canceled');
      }

      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) throw failure('VALIDATION', 'Version is unsafe');
      this.#database.prepare(`
        UPDATE reservation_resources
        SET status = 'canceled', version = ?
        WHERE tenant = ? AND id = ?
      `).run(nextVersion, tenant, input.id);
      this.#database.prepare(`
        UPDATE reservation_inventory
        SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, tenant, row.sku);

      const result = publicReservation({...row, status: 'canceled', version: nextVersion});
      this.#remember(tenant, 'cancel', input.key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    const tenant = authorize(actor);
    requireNonemptyString(sku);
    const row = this.#database.prepare(`
      SELECT sku, available, unit_cents
      FROM reservation_inventory
      WHERE tenant = ? AND sku = ?
    `).get(tenant, sku);
    if (!row) throw failure('NOT_FOUND', 'SKU was not found');
    return {sku: row.sku, available: row.available, unitCents: row.unit_cents};
  }

  get(actor, id) {
    const tenant = authorize(actor);
    requireNonemptyString(id);
    const row = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources
      WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (!row) throw failure('NOT_FOUND', 'Reservation was not found');
    return publicReservation(row);
  }

  list(actor, input) {
    const tenant = authorize(actor);
    requireExact(input, ['page', 'pageSize']);
    requireSafeInteger(input.page, 1);
    requireSafeInteger(input.pageSize, 1);
    if (input.pageSize > 50) throw failure('VALIDATION', 'Page size is too large');

    const {total} = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM reservation_resources WHERE tenant = ?
    `).get(tenant);
    const offset = (input.page - 1) * input.pageSize;
    if (!Number.isSafeInteger(offset)) return {items: [], total};
    const rows = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources
      WHERE tenant = ?
      ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(tenant, input.pageSize, offset);
    return {items: rows.map(publicReservation), total};
  }

  close() {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }
}
