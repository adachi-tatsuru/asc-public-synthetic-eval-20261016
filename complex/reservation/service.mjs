import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readExactObject(value, keys, code = 'VALIDATION') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure(code, 'Expected an object');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw failure(code, 'Object has unexpected keys');
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code, 'Accessor properties are not supported');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function actorDetails(actor) {
  const value = readExactObject(actor, ['tenant', 'role'], 'AUTH');
  if (typeof value.tenant !== 'string' || value.tenant.length === 0 ||
      (value.role !== 'admin' && value.role !== 'reader')) {
    throw failure('AUTH', 'Invalid actor');
  }
  return value;
}

function requireAdmin(actor) {
  const value = actorDetails(actor);
  if (value.role !== 'admin') throw failure('FORBIDDEN', 'Mutation requires admin role');
  return value;
}

function requireNonemptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw failure('VALIDATION', `${name} must be a nonempty string`);
  }
}

function requireSafeInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw failure('VALIDATION', `${name} must be a safe integer of at least ${minimum}`);
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
      SELECT canonical_input, result_json
      FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (row === undefined) return undefined;
    if (row.canonical_input !== canonicalInput) {
      throw failure('CONFLICT', 'Idempotency key was used with different input');
    }
    return JSON.parse(row.result_json);
  }

  #remember(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
      INSERT INTO reservation_idempotency
        (tenant, operation, idempotency_key, canonical_input, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    const {tenant} = requireAdmin(actor);
    const value = readExactObject(input, ['sku', 'available', 'unitCents']);
    requireNonemptyString(value.sku, 'sku');
    requireSafeInteger(value.available, 'available', 0);
    requireSafeInteger(value.unitCents, 'unitCents', 0);

    return this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(tenant, value.sku);
      if (existing !== undefined) throw failure('CONFLICT', 'SKU already exists');
      this.#database.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(tenant, value.sku, value.available, value.unitCents);
      return undefined;
    });
  }

  reserve(actor, input) {
    const {tenant} = requireAdmin(actor);
    const value = readExactObject(input, ['key', 'sku', 'quantity']);
    requireNonemptyString(value.key, 'key');
    requireNonemptyString(value.sku, 'sku');
    requireSafeInteger(value.quantity, 'quantity', 1);
    const canonicalInput = JSON.stringify({key: value.key, sku: value.sku, quantity: value.quantity});

    return this.#transaction(() => {
      const replay = this.#replay(tenant, 'reserve', value.key, canonicalInput);
      if (replay !== undefined) return replay;
      const inventory = this.#database.prepare(`
        SELECT available, unit_cents FROM reservation_inventory
        WHERE tenant = ? AND sku = ?
      `).get(tenant, value.sku);
      if (inventory === undefined) throw failure('NOT_FOUND', 'SKU was not found');
      if (inventory.available < value.quantity) {
        throw failure('CONFLICT', 'Insufficient inventory');
      }
      if (inventory.unit_cents !== 0 &&
          value.quantity > Math.floor(MAX_SAFE_INTEGER / inventory.unit_cents)) {
        throw failure('VALIDATION', 'Reservation amount exceeds safe integer range');
      }

      const result = {
        id: `reservation_${randomUUID()}`,
        tenant,
        sku: value.sku,
        quantity: value.quantity,
        amountCents: value.quantity * inventory.unit_cents,
        status: 'reserved',
        version: 1,
      };
      this.#database.prepare(`
        INSERT INTO reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, tenant, result.sku, result.quantity, result.amountCents);
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(result.quantity, tenant, result.sku);
      this.#remember(tenant, 'reserve', value.key, canonicalInput, result);
      return {...result};
    });
  }

  cancel(actor, input) {
    const {tenant} = requireAdmin(actor);
    const value = readExactObject(input, ['key', 'id', 'expectedVersion']);
    requireNonemptyString(value.key, 'key');
    requireNonemptyString(value.id, 'id');
    requireSafeInteger(value.expectedVersion, 'expectedVersion', 1);
    const canonicalInput = JSON.stringify({
      key: value.key,
      id: value.id,
      expectedVersion: value.expectedVersion,
    });

    return this.#transaction(() => {
      const replay = this.#replay(tenant, 'cancel', value.key, canonicalInput);
      if (replay !== undefined) return replay;
      const row = this.#database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_resources WHERE tenant = ? AND id = ?
      `).get(tenant, value.id);
      if (row === undefined) throw failure('NOT_FOUND', 'Reservation was not found');
      if (row.version !== value.expectedVersion || row.status !== 'reserved') {
        throw failure('CONFLICT', 'Reservation cannot be canceled');
      }

      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) {
        throw failure('VALIDATION', 'Reservation version exceeds safe integer range');
      }
      this.#database.prepare(`
        UPDATE reservation_resources SET status = 'canceled', version = ?
        WHERE tenant = ? AND id = ?
      `).run(nextVersion, tenant, value.id);
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, tenant, row.sku);

      const result = reservationFromRow({...row, status: 'canceled', version: nextVersion});
      this.#remember(tenant, 'cancel', value.key, canonicalInput, result);
      return {...result};
    });
  }

  inventory(actor, sku) {
    const {tenant} = actorDetails(actor);
    requireNonemptyString(sku, 'sku');
    const row = this.#database.prepare(`
      SELECT sku, available, unit_cents FROM reservation_inventory
      WHERE tenant = ? AND sku = ?
    `).get(tenant, sku);
    if (row === undefined) throw failure('NOT_FOUND', 'SKU was not found');
    return inventoryFromRow(row);
  }

  get(actor, id) {
    const {tenant} = actorDetails(actor);
    requireNonemptyString(id, 'id');
    const row = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (row === undefined) throw failure('NOT_FOUND', 'Reservation was not found');
    return reservationFromRow(row);
  }

  list(actor, input) {
    const {tenant} = actorDetails(actor);
    const value = readExactObject(input, ['page', 'pageSize']);
    requireSafeInteger(value.page, 'page', 1);
    requireSafeInteger(value.pageSize, 'pageSize', 1);
    if (value.pageSize > 50) throw failure('VALIDATION', 'pageSize must not exceed 50');

    const total = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM reservation_resources WHERE tenant = ?
    `).get(tenant).total;
    const pageStart = value.page - 1;
    if (pageStart > Math.floor(MAX_SAFE_INTEGER / value.pageSize)) {
      return {items: [], total};
    }
    const offset = pageStart * value.pageSize;
    const rows = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources WHERE tenant = ?
      ORDER BY creation_order LIMIT ? OFFSET ?
    `).all(tenant, value.pageSize, offset);
    return {items: rows.map(reservationFromRow), total};
  }

  close() {
    this.#database.close();
  }
}
