import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function hasExactOwnKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function requireObject(value, keys) {
  if (!hasExactOwnKeys(value, keys)) fail('VALIDATION', 'Invalid input');
  return value;
}

function requireString(value) {
  if (typeof value !== 'string' || value.length === 0) fail('VALIDATION', 'Expected a nonempty string');
  return value;
}

function requireInteger(value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('VALIDATION', 'Expected a safe integer');
  return value;
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

export class ReservationService {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reservation_inventory_v1 (
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        available INTEGER NOT NULL,
        unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reservation_resources_v1 (
        creation_order INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reservation_resources_v1_tenant_order
        ON reservation_resources_v1 (tenant, creation_order);
      CREATE TABLE IF NOT EXISTS reservation_idempotency_v1 (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        canonical_input TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      ) STRICT;
    `);
  }

  _actor(actor, mutation = false) {
    if (!hasExactOwnKeys(actor, ['tenant', 'role'])) fail('AUTH', 'Invalid actor');
    let tenant;
    let role;
    try {
      ({ tenant, role } = actor);
    } catch {
      fail('AUTH', 'Invalid actor');
    }
    if (typeof tenant !== 'string' || tenant.length === 0 || (role !== 'admin' && role !== 'reader')) {
      fail('AUTH', 'Invalid actor');
    }
    if (mutation && role !== 'admin') fail('FORBIDDEN', 'Actor may not mutate');
    return tenant;
  }

  _transaction(action) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the error which caused the transaction to fail.
      }
      throw error;
    }
  }

  _replay(tenant, operation, key, canonicalInput) {
    const row = this.database.prepare(`
      SELECT canonical_input, result
      FROM reservation_idempotency_v1
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (row === undefined) return undefined;
    if (row.canonical_input !== canonicalInput) fail('CONFLICT', 'Idempotency key was used for different input');
    return JSON.parse(row.result);
  }

  _remember(tenant, operation, key, canonicalInput, result) {
    this.database.prepare(`
      INSERT INTO reservation_idempotency_v1
        (tenant, operation, idempotency_key, canonical_input, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    const tenant = this._actor(actor, true);
    requireObject(input, ['sku', 'available', 'unitCents']);
    const sku = requireString(input.sku);
    const available = requireInteger(input.available, 0);
    const unitCents = requireInteger(input.unitCents, 0);

    return this._transaction(() => {
      const existing = this.database.prepare(`
        SELECT 1 FROM reservation_inventory_v1 WHERE tenant = ? AND sku = ?
      `).get(tenant, sku);
      if (existing !== undefined) fail('CONFLICT', 'SKU already exists');
      this.database.prepare(`
        INSERT INTO reservation_inventory_v1 (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(tenant, sku, available, unitCents);
    });
  }

  reserve(actor, input) {
    const tenant = this._actor(actor, true);
    requireObject(input, ['key', 'sku', 'quantity']);
    const key = requireString(input.key);
    const sku = requireString(input.sku);
    const quantity = requireInteger(input.quantity, 1);
    const canonicalInput = JSON.stringify({ sku, quantity });

    return this._transaction(() => {
      const replay = this._replay(tenant, 'reserve', key, canonicalInput);
      if (replay !== undefined) return replay;

      const inventory = this.database.prepare(`
        SELECT available, unit_cents FROM reservation_inventory_v1
        WHERE tenant = ? AND sku = ?
      `).get(tenant, sku);
      if (inventory === undefined) fail('NOT_FOUND', 'SKU not found');
      if (inventory.available < quantity) fail('CONFLICT', 'Insufficient inventory');
      const amountCents = quantity * inventory.unit_cents;
      if (!Number.isSafeInteger(amountCents)) fail('VALIDATION', 'Reservation amount is unsafe');

      const result = {
        id: randomUUID(),
        tenant,
        sku,
        quantity,
        amountCents,
        status: 'reserved',
        version: 1,
      };
      this.database.prepare(`
        UPDATE reservation_inventory_v1 SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(quantity, tenant, sku);
      this.database.prepare(`
        INSERT INTO reservation_resources_v1
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, tenant, sku, quantity, amountCents);
      this._remember(tenant, 'reserve', key, canonicalInput, result);
      return { ...result };
    });
  }

  cancel(actor, input) {
    const tenant = this._actor(actor, true);
    requireObject(input, ['key', 'id', 'expectedVersion']);
    const key = requireString(input.key);
    const id = requireString(input.id);
    const expectedVersion = requireInteger(input.expectedVersion, 1);
    const canonicalInput = JSON.stringify({ id, expectedVersion });

    return this._transaction(() => {
      const replay = this._replay(tenant, 'cancel', key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_resources_v1 WHERE tenant = ? AND id = ?
      `).get(tenant, id);
      if (row === undefined) fail('NOT_FOUND', 'Reservation not found');
      if (row.version !== expectedVersion || row.status !== 'reserved') {
        fail('CONFLICT', 'Reservation cannot be canceled');
      }

      this.database.prepare(`
        UPDATE reservation_resources_v1 SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(tenant, id);
      this.database.prepare(`
        UPDATE reservation_inventory_v1 SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, tenant, row.sku);
      const result = reservationFromRow({ ...row, status: 'canceled', version: row.version + 1 });
      this._remember(tenant, 'cancel', key, canonicalInput, result);
      return { ...result };
    });
  }

  inventory(actor, sku) {
    const tenant = this._actor(actor);
    requireString(sku);
    const row = this.database.prepare(`
      SELECT sku, available, unit_cents FROM reservation_inventory_v1
      WHERE tenant = ? AND sku = ?
    `).get(tenant, sku);
    if (row === undefined) fail('NOT_FOUND', 'SKU not found');
    return { sku: row.sku, available: row.available, unitCents: row.unit_cents };
  }

  get(actor, id) {
    const tenant = this._actor(actor);
    requireString(id);
    const row = this.database.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources_v1 WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (row === undefined) fail('NOT_FOUND', 'Reservation not found');
    return reservationFromRow(row);
  }

  list(actor, input) {
    const tenant = this._actor(actor);
    requireObject(input, ['page', 'pageSize']);
    const page = requireInteger(input.page, 1);
    const pageSize = requireInteger(input.pageSize, 1);
    if (pageSize > 50) fail('VALIDATION', 'Page size is too large');

    return this._transaction(() => {
      const { total } = this.database.prepare(`
        SELECT COUNT(*) AS total FROM reservation_resources_v1 WHERE tenant = ?
      `).get(tenant);
      if (page - 1 > Math.floor(Number.MAX_SAFE_INTEGER / pageSize)) return { items: [], total };
      const offset = (page - 1) * pageSize;
      if (offset >= total) return { items: [], total };
      const rows = this.database.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_resources_v1
        WHERE tenant = ? ORDER BY creation_order
        LIMIT ? OFFSET ?
      `).all(tenant, pageSize, offset);
      return { items: rows.map(reservationFromRow), total };
    });
  }

  close() {
    this.database.close();
  }
}
