import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  return keys.length === expectedKeys.length && expectedKeys.every(key => keys.includes(key));
}

function fields(value, expectedKeys) {
  if (!exactObject(value, expectedKeys)) fail('VALIDATION', 'Invalid input');
  try {
    return expectedKeys.map(key => value[key]);
  } catch {
    fail('VALIDATION', 'Invalid input');
  }
}

function actorTenant(actor, mutate = false) {
  if (!exactObject(actor, ['tenant', 'role'])) fail('AUTH', 'Invalid actor');
  let tenant;
  let role;
  try {
    tenant = actor.tenant;
    role = actor.role;
  } catch {
    fail('AUTH', 'Invalid actor');
  }
  if (typeof tenant !== 'string' || tenant.length === 0 ||
      (role !== 'admin' && role !== 'reader')) {
    fail('AUTH', 'Invalid actor');
  }
  if (mutate && role !== 'admin') fail('FORBIDDEN', 'Mutation requires admin role');
  return tenant;
}

const nonemptyString = value => typeof value === 'string' && value.length > 0;
const nonnegativeSafeInteger = value => Number.isSafeInteger(value) && value >= 0;
const positiveSafeInteger = value => Number.isSafeInteger(value) && value > 0;

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

function publicInventory(row) {
  return {sku: row.sku, available: row.available, unitCents: row.unit_cents};
}

export class ReservationService {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.closed = false;
    try {
      this.database.exec('PRAGMA busy_timeout = 5000');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS reservation_service_inventory (
          tenant TEXT NOT NULL,
          sku TEXT NOT NULL,
          available INTEGER NOT NULL,
          unit_cents INTEGER NOT NULL,
          PRIMARY KEY (tenant, sku)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS reservation_service_reservations (
          creation_order INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          tenant TEXT NOT NULL,
          sku TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          amount_cents INTEGER NOT NULL,
          status TEXT NOT NULL,
          version INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS reservation_service_reservations_tenant_order
          ON reservation_service_reservations (tenant, creation_order);
        CREATE TABLE IF NOT EXISTS reservation_service_idempotency (
          tenant TEXT NOT NULL,
          operation TEXT NOT NULL,
          idem_key TEXT NOT NULL,
          canonical_input TEXT NOT NULL,
          result TEXT NOT NULL,
          PRIMARY KEY (tenant, operation, idem_key)
        ) STRICT;
      `);
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  transaction(action) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the error that caused the transaction to fail.
      }
      throw error;
    }
  }

  replay(tenant, operation, key, canonicalInput) {
    const row = this.database.prepare(`
      SELECT canonical_input, result FROM reservation_service_idempotency
      WHERE tenant = ? AND operation = ? AND idem_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonicalInput) {
      fail('CONFLICT', 'Idempotency key has different input');
    }
    return JSON.parse(row.result);
  }

  remember(tenant, operation, key, canonicalInput, result) {
    this.database.prepare(`
      INSERT INTO reservation_service_idempotency
        (tenant, operation, idem_key, canonical_input, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    const tenant = actorTenant(actor, true);
    const [sku, available, unitCents] = fields(input, ['sku', 'available', 'unitCents']);
    if (!nonemptyString(sku) || !nonnegativeSafeInteger(available) ||
        !nonnegativeSafeInteger(unitCents)) {
      fail('VALIDATION', 'Invalid inventory');
    }
    this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT 1 FROM reservation_service_inventory WHERE tenant = ? AND sku = ?
      `).get(tenant, sku);
      if (existing) fail('CONFLICT', 'SKU already exists');
      this.database.prepare(`
        INSERT INTO reservation_service_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(tenant, sku, available, unitCents);
    });
  }

  reserve(actor, input) {
    const tenant = actorTenant(actor, true);
    const [key, sku, quantity] = fields(input, ['key', 'sku', 'quantity']);
    if (!nonemptyString(key) || !nonemptyString(sku) || !positiveSafeInteger(quantity)) {
      fail('VALIDATION', 'Invalid reservation');
    }
    const canonicalInput = JSON.stringify({sku, quantity});
    return this.transaction(() => {
      const replay = this.replay(tenant, 'reserve', key, canonicalInput);
      if (replay !== undefined) return replay;
      const inventory = this.database.prepare(`
        SELECT available, unit_cents FROM reservation_service_inventory
        WHERE tenant = ? AND sku = ?
      `).get(tenant, sku);
      if (!inventory) fail('NOT_FOUND', 'SKU not found');
      if (quantity > inventory.available) fail('CONFLICT', 'Insufficient inventory');
      if (inventory.unit_cents !== 0 &&
          quantity > Math.floor(MAX_SAFE_INTEGER / inventory.unit_cents)) {
        fail('VALIDATION', 'Reservation amount is unsafe');
      }
      const result = {
        id: randomUUID(), tenant, sku, quantity,
        amountCents: quantity * inventory.unit_cents,
        status: 'reserved', version: 1,
      };
      this.database.prepare(`
        UPDATE reservation_service_inventory SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(quantity, tenant, sku);
      this.database.prepare(`
        INSERT INTO reservation_service_reservations
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, tenant, sku, quantity, result.amountCents);
      this.remember(tenant, 'reserve', key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    const tenant = actorTenant(actor, true);
    const [key, id, expectedVersion] = fields(input, ['key', 'id', 'expectedVersion']);
    if (!nonemptyString(key) || !nonemptyString(id) || !positiveSafeInteger(expectedVersion)) {
      fail('VALIDATION', 'Invalid cancellation');
    }
    const canonicalInput = JSON.stringify({id, expectedVersion});
    return this.transaction(() => {
      const replay = this.replay(tenant, 'cancel', key, canonicalInput);
      if (replay !== undefined) return replay;
      const row = this.database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_service_reservations WHERE tenant = ? AND id = ?
      `).get(tenant, id);
      if (!row) fail('NOT_FOUND', 'Reservation not found');
      if (row.version !== expectedVersion) fail('CONFLICT', 'Stale reservation version');
      if (row.status !== 'reserved') fail('CONFLICT', 'Reservation cannot be canceled');
      this.database.prepare(`
        UPDATE reservation_service_reservations SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(tenant, id);
      this.database.prepare(`
        UPDATE reservation_service_inventory SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, tenant, row.sku);
      const result = {
        id: row.id, tenant: row.tenant, sku: row.sku, quantity: row.quantity,
        amountCents: row.amount_cents, status: 'canceled', version: row.version + 1,
      };
      this.remember(tenant, 'cancel', key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    const tenant = actorTenant(actor);
    if (!nonemptyString(sku)) fail('VALIDATION', 'Invalid SKU');
    const row = this.database.prepare(`
      SELECT sku, available, unit_cents FROM reservation_service_inventory
      WHERE tenant = ? AND sku = ?
    `).get(tenant, sku);
    if (!row) fail('NOT_FOUND', 'SKU not found');
    return publicInventory(row);
  }

  get(actor, id) {
    const tenant = actorTenant(actor);
    if (!nonemptyString(id)) fail('VALIDATION', 'Invalid reservation ID');
    const row = this.database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_service_reservations WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (!row) fail('NOT_FOUND', 'Reservation not found');
    return publicReservation(row);
  }

  list(actor, input) {
    const tenant = actorTenant(actor);
    const [page, pageSize] = fields(input, ['page', 'pageSize']);
    if (!positiveSafeInteger(page) || !positiveSafeInteger(pageSize) || pageSize > 50) {
      fail('VALIDATION', 'Invalid pagination');
    }
    const {total} = this.database.prepare(`
      SELECT count(*) AS total FROM reservation_service_reservations WHERE tenant = ?
    `).get(tenant);
    if (total === 0 || page > Math.ceil(total / pageSize)) return {items: [], total};
    const offset = (page - 1) * pageSize;
    const rows = this.database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_service_reservations WHERE tenant = ?
      ORDER BY creation_order LIMIT ? OFFSET ?
    `).all(tenant, pageSize, offset);
    return {items: rows.map(publicReservation), total};
  }

  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
