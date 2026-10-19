import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every(key => keys.includes(key));
}

function requireExact(value, keys) {
  if (!hasExactKeys(value, keys)) throw failure('VALIDATION', 'Invalid input');
}

function requireNonemptyString(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw failure('VALIDATION', 'Expected a nonempty string');
  }
}

function requireSafeInteger(value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw failure('VALIDATION', 'Expected a bounded integer');
  }
}

function authenticate(actor, mutation = false) {
  if (!hasExactKeys(actor, ['tenant', 'role']) ||
      typeof actor.tenant !== 'string' || actor.tenant.length === 0 ||
      (actor.role !== 'admin' && actor.role !== 'reader')) {
    throw failure('AUTH', 'Invalid actor');
  }
  if (mutation && actor.role !== 'admin') throw failure('FORBIDDEN', 'Mutation is not allowed');
  return actor.tenant;
}

function asNumber(value) {
  const integer = typeof value === 'bigint' ? value : BigInt(value);
  if (integer < -MAX_SAFE || integer > MAX_SAFE) throw new Error('Corrupt integer in reservation database');
  return Number(integer);
}

function publicReservation(row) {
  return {
    id: row.id,
    tenant: row.tenant,
    sku: row.sku,
    quantity: asNumber(row.quantity),
    amountCents: asNumber(row.amount_cents),
    status: row.status,
    version: asNumber(row.version),
    currency: 'JPY',
  };
}

function publicInventory(row) {
  return {
    sku: row.sku,
    available: asNumber(row.available),
    unitCents: asNumber(row.unit_cents),
  };
}

export class ReservationService {
  #database;

  constructor(filename) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS asc_reservation_inventory (
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        available INTEGER NOT NULL,
        unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS asc_reservation_resources (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS asc_reservation_resources_tenant_sequence
        ON asc_reservation_resources (tenant, sequence);
      CREATE TABLE IF NOT EXISTS asc_reservation_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      ) STRICT;
    `);
  }

  #statement(sql) {
    const statement = this.#database.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  }

  #transaction(action) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  #replay(tenant, operation, key, canonicalInput) {
    const row = this.#statement(`
      SELECT canonical_input, result
      FROM asc_reservation_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (row === undefined) return undefined;
    if (row.canonical_input !== canonicalInput) {
      throw failure('CONFLICT', 'Idempotency key was used for a different input');
    }
    return {...JSON.parse(row.result), currency: 'JPY'};
  }

  #record(tenant, operation, key, canonicalInput, result) {
    this.#statement(`
      INSERT INTO asc_reservation_idempotency
        (tenant, operation, idempotency_key, canonical_input, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    const tenant = authenticate(actor, true);
    requireExact(input, ['sku', 'available', 'unitCents']);
    requireNonemptyString(input.sku);
    requireSafeInteger(input.available, 0);
    requireSafeInteger(input.unitCents, 0);

    this.#transaction(() => {
      const existing = this.#statement(`
        SELECT 1 FROM asc_reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(tenant, input.sku);
      if (existing !== undefined) throw failure('CONFLICT', 'SKU already exists');
      this.#statement(`
        INSERT INTO asc_reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(tenant, input.sku, BigInt(input.available), BigInt(input.unitCents));
    });
  }

  reserve(actor, input) {
    const tenant = authenticate(actor, true);
    requireExact(input, ['key', 'sku', 'quantity']);
    requireNonemptyString(input.key);
    requireNonemptyString(input.sku);
    requireSafeInteger(input.quantity, 1);
    const canonicalInput = JSON.stringify({sku: input.sku, quantity: input.quantity});

    return this.#transaction(() => {
      const replay = this.#replay(tenant, 'reserve', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const inventory = this.#statement(`
        SELECT sku, available, unit_cents
        FROM asc_reservation_inventory
        WHERE tenant = ? AND sku = ?
      `).get(tenant, input.sku);
      if (inventory === undefined) throw failure('NOT_FOUND', 'SKU not found');
      const available = asNumber(inventory.available);
      const unitCents = asNumber(inventory.unit_cents);
      if (input.quantity > available) throw failure('CONFLICT', 'Insufficient inventory');
      if (unitCents !== 0 && input.quantity > Math.floor(Number.MAX_SAFE_INTEGER / unitCents)) {
        throw failure('VALIDATION', 'Reservation amount is not a safe integer');
      }

      const result = {
        id: randomUUID(),
        tenant,
        sku: input.sku,
        quantity: input.quantity,
        amountCents: input.quantity * unitCents,
        status: 'reserved',
        version: 1,
        currency: 'JPY',
      };
      this.#statement(`
        UPDATE asc_reservation_inventory
        SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(BigInt(input.quantity), tenant, input.sku);
      this.#statement(`
        INSERT INTO asc_reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, tenant, result.sku, BigInt(result.quantity), BigInt(result.amountCents));
      this.#record(tenant, 'reserve', input.key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    const tenant = authenticate(actor, true);
    requireExact(input, ['key', 'id', 'expectedVersion']);
    requireNonemptyString(input.key);
    requireNonemptyString(input.id);
    requireSafeInteger(input.expectedVersion, 1);
    const canonicalInput = JSON.stringify({id: input.id, expectedVersion: input.expectedVersion});

    return this.#transaction(() => {
      const replay = this.#replay(tenant, 'cancel', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.#statement(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM asc_reservation_resources
        WHERE tenant = ? AND id = ?
      `).get(tenant, input.id);
      if (row === undefined) throw failure('NOT_FOUND', 'Reservation not found');
      if (asNumber(row.version) !== input.expectedVersion || row.status !== 'reserved') {
        throw failure('CONFLICT', 'Reservation cannot be canceled');
      }

      this.#statement(`
        UPDATE asc_reservation_resources
        SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(tenant, input.id);
      this.#statement(`
        UPDATE asc_reservation_inventory
        SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, tenant, row.sku);
      const result = {
        ...publicReservation(row),
        status: 'canceled',
        version: input.expectedVersion + 1,
      };
      this.#record(tenant, 'cancel', input.key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    const tenant = authenticate(actor);
    requireNonemptyString(sku);
    const row = this.#statement(`
      SELECT sku, available, unit_cents
      FROM asc_reservation_inventory
      WHERE tenant = ? AND sku = ?
    `).get(tenant, sku);
    if (row === undefined) throw failure('NOT_FOUND', 'SKU not found');
    return publicInventory(row);
  }

  get(actor, id) {
    const tenant = authenticate(actor);
    requireNonemptyString(id);
    const row = this.#statement(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM asc_reservation_resources
      WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (row === undefined) throw failure('NOT_FOUND', 'Reservation not found');
    return publicReservation(row);
  }

  list(actor, input) {
    const tenant = authenticate(actor);
    requireExact(input, ['page', 'pageSize']);
    requireSafeInteger(input.page, 1);
    requireSafeInteger(input.pageSize, 1);
    if (input.pageSize > 50) throw failure('VALIDATION', 'Page size is too large');

    this.#database.exec('BEGIN');
    try {
      const countRow = this.#statement(`
        SELECT COUNT(*) AS total FROM asc_reservation_resources WHERE tenant = ?
      `).get(tenant);
      const total = asNumber(countRow.total);
      const firstIndex = (input.page - 1) * input.pageSize;
      let items = [];
      if (Number.isSafeInteger(firstIndex) && firstIndex < total) {
        const rows = this.#statement(`
          SELECT id, tenant, sku, quantity, amount_cents, status, version
          FROM asc_reservation_resources
          WHERE tenant = ?
          ORDER BY sequence
          LIMIT ? OFFSET ?
        `).all(tenant, BigInt(input.pageSize), BigInt(firstIndex));
        items = rows.map(publicReservation);
      }
      this.#database.exec('COMMIT');
      return {items, total};
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the read error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  close() {
    this.#database.close();
  }
}
