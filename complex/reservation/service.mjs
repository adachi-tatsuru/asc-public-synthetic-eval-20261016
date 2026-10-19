import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const ERROR_CODES = Object.freeze({
  auth: 'AUTH',
  forbidden: 'FORBIDDEN',
  validation: 'VALIDATION',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function hasExactDataKeys(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value');
    });
  } catch {
    // Normalize proxy/revocation failures through the caller's contract error.
    return false;
  }
}

function exactInput(value, keys) {
  if (!hasExactDataKeys(value, keys)) fail(ERROR_CODES.validation, 'Invalid input shape');
  return Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key).value]));
}

function actorDetails(actor) {
  if (!hasExactDataKeys(actor, ['tenant', 'role'])) fail(ERROR_CODES.auth, 'Invalid actor');
  const tenant = Object.getOwnPropertyDescriptor(actor, 'tenant').value;
  const role = Object.getOwnPropertyDescriptor(actor, 'role').value;
  if (typeof tenant !== 'string' || tenant.length === 0 || (role !== 'admin' && role !== 'reader')) {
    fail(ERROR_CODES.auth, 'Invalid actor');
  }
  return {tenant, role};
}

function requireAdmin(actor) {
  const details = actorDetails(actor);
  if (details.role !== 'admin') fail(ERROR_CODES.forbidden, 'Mutation requires admin role');
  return details;
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
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

function replayResult(serialized) {
  return Object.freeze(JSON.parse(serialized));
}

export class ReservationService {
  #database;

  constructor(filename) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
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
        result_json TEXT NOT NULL,
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
        // Preserve the operation error if SQLite has already ended the transaction.
      }
      throw error;
    }
  }

  #findReplay(tenant, operation, key, canonicalInput) {
    const row = this.#database.prepare(`
      SELECT canonical_input, result_json
      FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonicalInput) fail(ERROR_CODES.conflict, 'Idempotency key reused');
    return replayResult(row.result_json);
  }

  #recordReplay(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
      INSERT INTO reservation_idempotency
        (tenant, operation, idempotency_key, canonical_input, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    const {tenant} = requireAdmin(actor);
    const {sku, available, unitCents} = exactInput(input, ['sku', 'available', 'unitCents']);
    if (!nonemptyString(sku) || !safeInteger(available, 0) || !safeInteger(unitCents, 0)) {
      fail(ERROR_CODES.validation, 'Invalid inventory item');
    }
    return this.#transaction(() => {
      const exists = this.#database.prepare(
        'SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?',
      ).get(tenant, sku);
      if (exists) fail(ERROR_CODES.conflict, 'SKU already exists');
      this.#database.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(tenant, sku, available, unitCents);
    });
  }

  reserve(actor, input) {
    const {tenant} = requireAdmin(actor);
    const {key, sku, quantity} = exactInput(input, ['key', 'sku', 'quantity']);
    if (!nonemptyString(key) || !nonemptyString(sku) || !safeInteger(quantity, 1)) {
      fail(ERROR_CODES.validation, 'Invalid reservation');
    }
    const canonicalInput = JSON.stringify([sku, quantity]);
    return this.#transaction(() => {
      const replay = this.#findReplay(tenant, 'reserve', key, canonicalInput);
      if (replay) return replay;

      const inventory = this.#database.prepare(`
        SELECT available, unit_cents FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(tenant, sku);
      if (!inventory) fail(ERROR_CODES.notFound, 'SKU not found');
      if (inventory.available < quantity) fail(ERROR_CODES.conflict, 'Insufficient inventory');
      if (inventory.unit_cents !== 0 && quantity > Math.floor(Number.MAX_SAFE_INTEGER / inventory.unit_cents)) {
        fail(ERROR_CODES.validation, 'Reservation amount is unsafe');
      }

      const result = Object.freeze({
        id: randomUUID(),
        tenant,
        sku,
        quantity,
        amountCents: quantity * inventory.unit_cents,
        status: 'reserved',
        version: 1,
      });
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available - ? WHERE tenant = ? AND sku = ?
      `).run(quantity, tenant, sku);
      this.#database.prepare(`
        INSERT INTO reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, tenant, sku, quantity, result.amountCents);
      this.#recordReplay(tenant, 'reserve', key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    const {tenant} = requireAdmin(actor);
    const {key, id, expectedVersion} = exactInput(input, ['key', 'id', 'expectedVersion']);
    if (!nonemptyString(key) || !nonemptyString(id) || !safeInteger(expectedVersion, 1)) {
      fail(ERROR_CODES.validation, 'Invalid cancellation');
    }
    const canonicalInput = JSON.stringify([id, expectedVersion]);
    return this.#transaction(() => {
      const replay = this.#findReplay(tenant, 'cancel', key, canonicalInput);
      if (replay) return replay;

      const row = this.#database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_resources WHERE tenant = ? AND id = ?
      `).get(tenant, id);
      if (!row) fail(ERROR_CODES.notFound, 'Reservation not found');
      if (row.version !== expectedVersion || row.status !== 'reserved') {
        fail(ERROR_CODES.conflict, 'Reservation cannot be canceled');
      }

      this.#database.prepare(`
        UPDATE reservation_resources SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(tenant, id);
      this.#database.prepare(`
        UPDATE reservation_inventory SET available = available + ? WHERE tenant = ? AND sku = ?
      `).run(row.quantity, tenant, row.sku);
      const result = publicReservation({...row, status: 'canceled', version: row.version + 1});
      this.#recordReplay(tenant, 'cancel', key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    const {tenant} = actorDetails(actor);
    if (!nonemptyString(sku)) fail(ERROR_CODES.validation, 'Invalid SKU');
    const row = this.#database.prepare(`
      SELECT sku, available, unit_cents FROM reservation_inventory WHERE tenant = ? AND sku = ?
    `).get(tenant, sku);
    if (!row) fail(ERROR_CODES.notFound, 'SKU not found');
    return Object.freeze({sku: row.sku, available: row.available, unitCents: row.unit_cents});
  }

  get(actor, id) {
    const {tenant} = actorDetails(actor);
    if (!nonemptyString(id)) fail(ERROR_CODES.validation, 'Invalid reservation ID');
    const row = this.#database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (!row) fail(ERROR_CODES.notFound, 'Reservation not found');
    return publicReservation(row);
  }

  list(actor, input) {
    const {tenant} = actorDetails(actor);
    const {page, pageSize} = exactInput(input, ['page', 'pageSize']);
    if (!safeInteger(page, 1) || !safeInteger(pageSize, 1) || pageSize > 50) {
      fail(ERROR_CODES.validation, 'Invalid pagination');
    }
    const total = this.#database.prepare(
      'SELECT count(*) AS total FROM reservation_resources WHERE tenant = ?',
    ).get(tenant).total;
    const offset = (page - 1) * pageSize;
    const rows = Number.isSafeInteger(offset)
      ? this.#database.prepare(`
          SELECT id, tenant, sku, quantity, amount_cents, status, version
          FROM reservation_resources WHERE tenant = ? ORDER BY sequence LIMIT ? OFFSET ?
        `).all(tenant, pageSize, offset)
      : [];
    return Object.freeze({items: Object.freeze(rows.map(publicReservation)), total});
  }

  close() {
    this.#database.close();
  }
}
