import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const PUBLIC_COLUMNS = 'id, tenant, sku, quantity, amount_cents, status, version';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object') return false;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return false; }
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function snapshot(value, expected, code = 'VALIDATION') {
  if (!hasExactKeys(value, expected)) throw failure(code, `Invalid ${code === 'AUTH' ? 'actor' : 'input'}`);
  const result = {};
  try {
    for (const key of expected) result[key] = value[key];
  } catch {
    throw failure(code, `Invalid ${code === 'AUTH' ? 'actor' : 'input'}`);
  }
  return result;
}

function actorSnapshot(actor) {
  const result = snapshot(actor, ['tenant', 'role'], 'AUTH');
  if (typeof result.tenant !== 'string' || result.tenant.length === 0
      || (result.role !== 'admin' && result.role !== 'reader')) {
    throw failure('AUTH', 'Invalid actor');
  }
  return result;
}

function requireAdmin(actor) {
  if (actor.role !== 'admin') throw failure('FORBIDDEN', 'Mutation requires admin role');
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
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
    currency: 'JPY',
  };
}

function replayedReservation(value) {
  return {
    id: value.id,
    tenant: value.tenant,
    sku: value.sku,
    quantity: value.quantity,
    amountCents: value.amountCents,
    status: value.status,
    version: value.version,
    currency: 'JPY',
  };
}

export class ReservationService {
  #database;
  #closed = false;

  constructor(filename) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reservation_inventory (
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        available INTEGER NOT NULL CHECK (available >= 0),
        unit_cents INTEGER NOT NULL CHECK (unit_cents >= 0),
        PRIMARY KEY (tenant, sku)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reservation_resources (
        creation_order INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'canceled')),
        version INTEGER NOT NULL CHECK (version >= 1)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reservation_resources_tenant_order
        ON reservation_resources (tenant, creation_order);
      CREATE TABLE IF NOT EXISTS reservation_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      ) STRICT;
    `);
  }

  #transaction(callback) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  #replay(tenant, operation, key, canonicalInput) {
    const row = this.#database.prepare(`
      SELECT canonical_input, result_json
      FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (row === undefined) return undefined;
    if (row.canonical_input !== canonicalInput) {
      throw failure('CONFLICT', 'Idempotency key was used with different input');
    }
    return replayedReservation(JSON.parse(row.result_json));
  }

  #remember(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
      INSERT INTO reservation_idempotency
        (tenant, operation, idempotency_key, canonical_input, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    const authenticated = actorSnapshot(actor);
    requireAdmin(authenticated);
    const values = snapshot(input, ['sku', 'available', 'unitCents']);
    if (!nonemptyString(values.sku)
        || !safeInteger(values.available, 0)
        || !safeInteger(values.unitCents, 0)) {
      throw failure('VALIDATION', 'Invalid inventory input');
    }
    return this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(authenticated.tenant, values.sku);
      if (existing !== undefined) throw failure('CONFLICT', 'Inventory item already exists');
      this.#database.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(authenticated.tenant, values.sku, values.available, values.unitCents);
      return undefined;
    });
  }

  reserve(actor, input) {
    const authenticated = actorSnapshot(actor);
    requireAdmin(authenticated);
    const values = snapshot(input, ['key', 'sku', 'quantity']);
    if (!nonemptyString(values.key) || !nonemptyString(values.sku)
        || !safeInteger(values.quantity, 1)) {
      throw failure('VALIDATION', 'Invalid reservation input');
    }
    const canonicalInput = JSON.stringify([values.sku, values.quantity]);
    return this.#transaction(() => {
      const replayed = this.#replay(authenticated.tenant, 'reserve', values.key, canonicalInput);
      if (replayed !== undefined) return replayed;
      const inventory = this.#database.prepare(`
        SELECT available, unit_cents FROM reservation_inventory
        WHERE tenant = ? AND sku = ?
      `).get(authenticated.tenant, values.sku);
      if (inventory === undefined) throw failure('NOT_FOUND', 'Inventory item not found');
      if (inventory.available < values.quantity) throw failure('CONFLICT', 'Insufficient inventory');
      const amountCents = inventory.unit_cents * values.quantity;
      if (!Number.isSafeInteger(amountCents)) throw failure('VALIDATION', 'Reservation amount is unsafe');
      const result = {
        id: `reservation-${randomUUID()}`,
        tenant: authenticated.tenant,
        sku: values.sku,
        quantity: values.quantity,
        amountCents,
        status: 'reserved',
        version: 1,
        currency: 'JPY',
      };
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(values.quantity, authenticated.tenant, values.sku);
      this.#database.prepare(`
        INSERT INTO reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, result.tenant, result.sku, result.quantity, result.amountCents);
      this.#remember(authenticated.tenant, 'reserve', values.key, canonicalInput, result);
      return {...result};
    });
  }

  cancel(actor, input) {
    const authenticated = actorSnapshot(actor);
    requireAdmin(authenticated);
    const values = snapshot(input, ['key', 'id', 'expectedVersion']);
    if (!nonemptyString(values.key) || !nonemptyString(values.id)
        || !safeInteger(values.expectedVersion, 1)) {
      throw failure('VALIDATION', 'Invalid cancellation input');
    }
    const canonicalInput = JSON.stringify([values.id, values.expectedVersion]);
    return this.#transaction(() => {
      const replayed = this.#replay(authenticated.tenant, 'cancel', values.key, canonicalInput);
      if (replayed !== undefined) return replayed;
      const row = this.#database.prepare(`
        SELECT ${PUBLIC_COLUMNS} FROM reservation_resources
        WHERE tenant = ? AND id = ?
      `).get(authenticated.tenant, values.id);
      if (row === undefined) throw failure('NOT_FOUND', 'Reservation not found');
      if (row.version !== values.expectedVersion) throw failure('CONFLICT', 'Stale reservation version');
      if (row.status !== 'reserved') throw failure('CONFLICT', 'Reservation cannot be canceled');
      this.#database.prepare(`
        UPDATE reservation_resources SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(authenticated.tenant, values.id);
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, authenticated.tenant, row.sku);
      const result = {...publicReservation(row), status: 'canceled', version: row.version + 1};
      this.#remember(authenticated.tenant, 'cancel', values.key, canonicalInput, result);
      return {...result};
    });
  }

  inventory(actor, sku) {
    const authenticated = actorSnapshot(actor);
    if (!nonemptyString(sku)) throw failure('VALIDATION', 'Invalid SKU');
    const row = this.#database.prepare(`
      SELECT sku, available, unit_cents FROM reservation_inventory
      WHERE tenant = ? AND sku = ?
    `).get(authenticated.tenant, sku);
    if (row === undefined) throw failure('NOT_FOUND', 'Inventory item not found');
    return {sku: row.sku, available: row.available, unitCents: row.unit_cents};
  }

  get(actor, id) {
    const authenticated = actorSnapshot(actor);
    if (!nonemptyString(id)) throw failure('VALIDATION', 'Invalid reservation ID');
    const row = this.#database.prepare(`
      SELECT ${PUBLIC_COLUMNS} FROM reservation_resources
      WHERE tenant = ? AND id = ?
    `).get(authenticated.tenant, id);
    if (row === undefined) throw failure('NOT_FOUND', 'Reservation not found');
    return publicReservation(row);
  }

  list(actor, input) {
    const authenticated = actorSnapshot(actor);
    const values = snapshot(input, ['page', 'pageSize']);
    if (!safeInteger(values.page, 1) || !safeInteger(values.pageSize, 1)
        || values.pageSize > 50) {
      throw failure('VALIDATION', 'Invalid pagination input');
    }
    const count = this.#database.prepare(`
      SELECT count(*) AS total FROM reservation_resources WHERE tenant = ?
    `).get(authenticated.tenant).total;
    const offsetBigInt = BigInt(values.page - 1) * BigInt(values.pageSize);
    if (offsetBigInt >= BigInt(count)) return {items: [], total: count};
    const rows = this.#database.prepare(`
      SELECT ${PUBLIC_COLUMNS} FROM reservation_resources
      WHERE tenant = ? ORDER BY creation_order LIMIT ? OFFSET ?
    `).all(authenticated.tenant, values.pageSize, Number(offsetBigInt));
    return {items: rows.map(publicReservation), total: count};
  }

  close() {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }
}
