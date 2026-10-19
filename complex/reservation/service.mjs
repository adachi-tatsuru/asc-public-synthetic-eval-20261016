import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function raise(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateActor(actor, mutating = false) {
  const tenant = actor !== null && typeof actor === 'object' ? actor.tenant : undefined;
  const role = actor !== null && typeof actor === 'object' ? actor.role : undefined;
  if (
    actor === null ||
    typeof actor !== 'object' ||
    typeof tenant !== 'string' ||
    tenant.length === 0 ||
    (role !== 'admin' && role !== 'reader')
  ) {
    raise('AUTH', 'Invalid actor');
  }
  if (mutating && role !== 'admin') {
    raise('FORBIDDEN', 'The actor cannot mutate reservations');
  }
  return tenant;
}

function validateExactObject(value, keys) {
  if (value === null || typeof value !== 'object') {
    raise('VALIDATION', 'Expected an object');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    raise('VALIDATION', 'Input has unexpected keys');
  }
}

function validateNonemptyString(value) {
  if (typeof value !== 'string' || value.length === 0) {
    raise('VALIDATION', 'Expected a nonempty string');
  }
}

function validateSafeInteger(value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    raise('VALIDATION', 'Expected a bounded safe integer');
  }
}

function publicReservation(row) {
  return Object.freeze({
    id: row.id,
    tenant: row.tenant,
    sku: row.sku,
    quantity: row.quantity,
    amountCents: row.amountCents,
    status: row.status,
    version: row.version,
    currency: 'JPY',
  });
}

function publicInventory(row) {
  return Object.freeze({
    sku: row.sku,
    available: row.available,
    unitCents: row.unitCents,
  });
}

export class ReservationService {
  #database;
  #closed = false;

  constructor(filename) {
    this.#database = new DatabaseSync(filename, { timeout: 5000 });
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reservation_service_v1_inventory (
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        available INTEGER NOT NULL,
        unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      );
      CREATE TABLE IF NOT EXISTS reservation_service_v1_reservations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reservation_service_v1_reservations_tenant_sequence
        ON reservation_service_v1_reservations (tenant, sequence);
      CREATE TABLE IF NOT EXISTS reservation_service_v1_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
    `);
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
        // Preserve the error which caused the transaction to fail.
      }
      throw error;
    }
  }

  #idempotentResult(tenant, operation, key, canonicalInput) {
    const record = this.#database.prepare(`
      SELECT canonical_input AS canonicalInput, result
      FROM reservation_service_v1_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (record === undefined) return undefined;
    if (record.canonicalInput !== canonicalInput) {
      raise('CONFLICT', 'Idempotency key was used with different input');
    }
    return publicReservation(JSON.parse(record.result));
  }

  #storeIdempotentResult(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
      INSERT INTO reservation_service_v1_idempotency
        (tenant, operation, idempotency_key, canonical_input, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    const tenant = validateActor(actor, true);
    validateExactObject(input, ['sku', 'available', 'unitCents']);
    const { sku, available, unitCents } = input;
    validateNonemptyString(sku);
    validateSafeInteger(available, 0);
    validateSafeInteger(unitCents, 0);

    this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT 1
        FROM reservation_service_v1_inventory
        WHERE tenant = ? AND sku = ?
      `).get(tenant, sku);
      if (existing !== undefined) {
        raise('CONFLICT', 'Inventory item already exists');
      }
      this.#database.prepare(`
        INSERT INTO reservation_service_v1_inventory
          (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(tenant, sku, available, unitCents);
    });
  }

  reserve(actor, input) {
    const tenant = validateActor(actor, true);
    validateExactObject(input, ['key', 'sku', 'quantity']);
    const { key, sku, quantity } = input;
    validateNonemptyString(key);
    validateNonemptyString(sku);
    validateSafeInteger(quantity, 1);
    const canonicalInput = JSON.stringify({
      key,
      sku,
      quantity,
    });

    return this.#transaction(() => {
      const replay = this.#idempotentResult(tenant, 'reserve', key, canonicalInput);
      if (replay !== undefined) return replay;

      const inventory = this.#database.prepare(`
        SELECT available, unit_cents AS unitCents
        FROM reservation_service_v1_inventory
        WHERE tenant = ? AND sku = ?
      `).get(tenant, sku);
      if (inventory === undefined) {
        raise('NOT_FOUND', 'Inventory item not found');
      }
      if (
        inventory.unitCents !== 0 &&
        quantity > Math.floor(MAX_SAFE_INTEGER / inventory.unitCents)
      ) {
        raise('VALIDATION', 'Reservation amount is not a safe integer');
      }
      if (inventory.available < quantity) {
        raise('CONFLICT', 'Insufficient inventory');
      }

      const amountCents = quantity * inventory.unitCents;
      const id = randomUUID();
      this.#database.prepare(`
        UPDATE reservation_service_v1_inventory
        SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(quantity, tenant, sku);
      this.#database.prepare(`
        INSERT INTO reservation_service_v1_reservations
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(id, tenant, sku, quantity, amountCents);

      const result = publicReservation({
        id,
        tenant,
        sku,
        quantity,
        amountCents,
        status: 'reserved',
        version: 1,
      });
      this.#storeIdempotentResult(tenant, 'reserve', key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    const tenant = validateActor(actor, true);
    validateExactObject(input, ['key', 'id', 'expectedVersion']);
    const { key, id, expectedVersion } = input;
    validateNonemptyString(key);
    validateNonemptyString(id);
    validateSafeInteger(expectedVersion, 1);
    const canonicalInput = JSON.stringify({
      key,
      id,
      expectedVersion,
    });

    return this.#transaction(() => {
      const replay = this.#idempotentResult(tenant, 'cancel', key, canonicalInput);
      if (replay !== undefined) return replay;

      const reservation = this.#database.prepare(`
        SELECT
          id,
          tenant,
          sku,
          quantity,
          amount_cents AS amountCents,
          status,
          version
        FROM reservation_service_v1_reservations
        WHERE tenant = ? AND id = ?
      `).get(tenant, id);
      if (reservation === undefined) {
        raise('NOT_FOUND', 'Reservation not found');
      }
      if (reservation.version !== expectedVersion) {
        raise('CONFLICT', 'Reservation version is stale');
      }
      if (reservation.status !== 'reserved') {
        raise('CONFLICT', 'Reservation cannot be canceled');
      }

      this.#database.prepare(`
        UPDATE reservation_service_v1_inventory
        SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(reservation.quantity, tenant, reservation.sku);
      this.#database.prepare(`
        UPDATE reservation_service_v1_reservations
        SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(tenant, id);

      const result = publicReservation({
        ...reservation,
        status: 'canceled',
        version: reservation.version + 1,
      });
      this.#storeIdempotentResult(tenant, 'cancel', key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    const tenant = validateActor(actor);
    validateNonemptyString(sku);
    const row = this.#database.prepare(`
      SELECT sku, available, unit_cents AS unitCents
      FROM reservation_service_v1_inventory
      WHERE tenant = ? AND sku = ?
    `).get(tenant, sku);
    if (row === undefined) {
      raise('NOT_FOUND', 'Inventory item not found');
    }
    return publicInventory(row);
  }

  get(actor, id) {
    const tenant = validateActor(actor);
    validateNonemptyString(id);
    const row = this.#database.prepare(`
      SELECT
        id,
        tenant,
        sku,
        quantity,
        amount_cents AS amountCents,
        status,
        version
      FROM reservation_service_v1_reservations
      WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (row === undefined) {
      raise('NOT_FOUND', 'Reservation not found');
    }
    return publicReservation(row);
  }

  list(actor, input) {
    const tenant = validateActor(actor);
    validateExactObject(input, ['page', 'pageSize']);
    const { page, pageSize } = input;
    validateSafeInteger(page, 1);
    validateSafeInteger(pageSize, 1);
    if (pageSize > 50) {
      raise('VALIDATION', 'pageSize must be at most 50');
    }

    const { total } = this.#database.prepare(`
      SELECT COUNT(*) AS total
      FROM reservation_service_v1_reservations
      WHERE tenant = ?
    `).get(tenant);
    if (page - 1 > Math.floor(MAX_SAFE_INTEGER / pageSize)) {
      return Object.freeze({ items: Object.freeze([]), total });
    }
    const offset = (page - 1) * pageSize;
    const rows = this.#database.prepare(`
      SELECT
        id,
        tenant,
        sku,
        quantity,
        amount_cents AS amountCents,
        status,
        version
      FROM reservation_service_v1_reservations
      WHERE tenant = ?
      ORDER BY sequence ASC
      LIMIT ? OFFSET ?
    `).all(tenant, pageSize, offset);
    const items = Object.freeze(rows.map(publicReservation));
    return Object.freeze({ items, total });
  }

  close() {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
