import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function actorTenant(actor, mutate = false) {
  if (actor === null || typeof actor !== 'object') {
    fail('AUTH', 'Invalid actor');
  }
  let tenant, role;
  try {
    if (Array.isArray(actor)) fail('AUTH', 'Invalid actor');
    tenant = actor.tenant;
    role = actor.role;
  } catch {
    fail('AUTH', 'Invalid actor');
  }
  if (typeof tenant !== 'string' || tenant.length === 0 ||
      (role !== 'admin' && role !== 'reader')) fail('AUTH', 'Invalid actor');
  if (mutate && role !== 'admin') fail('FORBIDDEN', 'Read only actor');
  return tenant;
}

function shape(value, keys) {
  if (value === null || typeof value !== 'object') {
    fail('VALIDATION', 'Invalid input shape');
  }
  try {
    if (Array.isArray(value)) fail('VALIDATION', 'Invalid input shape');
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length ||
        ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
      fail('VALIDATION', 'Invalid input shape');
    }
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail('VALIDATION', 'Invalid input shape');
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    fail('VALIDATION', 'Invalid input shape');
  }
}

function nonempty(value) {
  if (typeof value !== 'string' || value.length === 0) fail('VALIDATION', 'Expected nonempty string');
}

function integer(value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('VALIDATION', 'Expected safe integer');
}

function publicReservation(row) {
  return {
    id: row.id, tenant: row.tenant, sku: row.sku,
    quantity: row.quantity, amountCents: row.amount_cents,
    status: row.status, version: row.version,
  };
}

export class ReservationService {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reservation_inventory (
        tenant TEXT NOT NULL, sku TEXT NOT NULL,
        available INTEGER NOT NULL, unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      );
      CREATE TABLE IF NOT EXISTS reservation_resources (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL, sku TEXT NOT NULL,
        quantity INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reservation_resources_tenant_sequence
        ON reservation_resources (tenant, sequence);
      CREATE TABLE IF NOT EXISTS reservation_idempotency (
        tenant TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
        input TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, key)
      );
    `);
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  replay(tenant, operation, key, input) {
    const row = this.db.prepare(`
      SELECT input, result FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND key = ?
    `).get(tenant, operation, key);
    if (!row) return null;
    if (row.input !== input) fail('CONFLICT', 'Idempotency key reused');
    return JSON.parse(row.result);
  }

  remember(tenant, operation, key, input, result) {
    this.db.prepare(`
      INSERT INTO reservation_idempotency (tenant, operation, key, input, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, input, JSON.stringify(result));
  }

  seed(actor, input) {
    const tenant = actorTenant(actor, true);
    const request = shape(input, ['sku', 'available', 'unitCents']);
    nonempty(request.sku);
    integer(request.available, 0);
    integer(request.unitCents, 0);
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(tenant, request.sku);
      if (existing) fail('CONFLICT', 'SKU already exists');
      this.db.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(tenant, request.sku, request.available, request.unitCents);
    });
  }

  reserve(actor, input) {
    const tenant = actorTenant(actor, true);
    const request = shape(input, ['key', 'sku', 'quantity']);
    nonempty(request.key);
    nonempty(request.sku);
    integer(request.quantity, 1);
    const canonical = JSON.stringify({ sku: request.sku, quantity: request.quantity });
    return this.transaction(() => {
      const replayed = this.replay(tenant, 'reserve', request.key, canonical);
      if (replayed) return replayed;
      const stock = this.db.prepare(`
        SELECT available, unit_cents FROM reservation_inventory
        WHERE tenant = ? AND sku = ?
      `).get(tenant, request.sku);
      if (!stock) fail('NOT_FOUND', 'SKU not found');
      if (stock.available < request.quantity) fail('CONFLICT', 'Insufficient inventory');
      if (stock.unit_cents > Number.MAX_SAFE_INTEGER / request.quantity) {
        fail('VALIDATION', 'Amount exceeds safe integer');
      }
      const result = {
        id: randomUUID(), tenant, sku: request.sku, quantity: request.quantity,
        amountCents: request.quantity * stock.unit_cents,
        status: 'reserved', version: 1,
      };
      this.db.prepare(`
        UPDATE reservation_inventory SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(request.quantity, tenant, request.sku);
      this.db.prepare(`
        INSERT INTO reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, tenant, result.sku, result.quantity, result.amountCents);
      this.remember(tenant, 'reserve', request.key, canonical, result);
      return result;
    });
  }

  cancel(actor, input) {
    const tenant = actorTenant(actor, true);
    const request = shape(input, ['key', 'id', 'expectedVersion']);
    nonempty(request.key);
    nonempty(request.id);
    integer(request.expectedVersion, 1);
    const canonical = JSON.stringify({ id: request.id, expectedVersion: request.expectedVersion });
    return this.transaction(() => {
      const replayed = this.replay(tenant, 'cancel', request.key, canonical);
      if (replayed) return replayed;
      const row = this.db.prepare(`
        SELECT * FROM reservation_resources WHERE tenant = ? AND id = ?
      `).get(tenant, request.id);
      if (!row) fail('NOT_FOUND', 'Reservation not found');
      if (row.version !== request.expectedVersion || row.status !== 'reserved') {
        fail('CONFLICT', 'Reservation cannot be canceled');
      }
      this.db.prepare(`
        UPDATE reservation_resources SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(tenant, request.id);
      this.db.prepare(`
        UPDATE reservation_inventory SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, tenant, row.sku);
      const result = { ...publicReservation(row), status: 'canceled', version: row.version + 1 };
      this.remember(tenant, 'cancel', request.key, canonical, result);
      return result;
    });
  }

  inventory(actor, sku) {
    const tenant = actorTenant(actor);
    nonempty(sku);
    const row = this.db.prepare(`
      SELECT available, unit_cents FROM reservation_inventory
      WHERE tenant = ? AND sku = ?
    `).get(tenant, sku);
    if (!row) fail('NOT_FOUND', 'SKU not found');
    return { sku, available: row.available, unitCents: row.unit_cents };
  }

  get(actor, id) {
    const tenant = actorTenant(actor);
    nonempty(id);
    const row = this.db.prepare(`
      SELECT * FROM reservation_resources WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (!row) fail('NOT_FOUND', 'Reservation not found');
    return publicReservation(row);
  }

  list(actor, input) {
    const tenant = actorTenant(actor);
    const request = shape(input, ['page', 'pageSize']);
    integer(request.page, 1);
    integer(request.pageSize, 1);
    if (request.pageSize > 50) fail('VALIDATION', 'Page size too large');
    const total = this.db.prepare(`
      SELECT COUNT(*) AS total FROM reservation_resources WHERE tenant = ?
    `).get(tenant).total;
    const offset = (request.page - 1) * request.pageSize;
    if (!Number.isSafeInteger(offset) || offset >= total) return { items: [], total };
    const rows = this.db.prepare(`
      SELECT * FROM reservation_resources WHERE tenant = ?
      ORDER BY sequence LIMIT ? OFFSET ?
    `).all(tenant, request.pageSize, offset);
    return { items: rows.map(publicReservation), total };
  }

  close() {
    this.db.close();
  }
}
