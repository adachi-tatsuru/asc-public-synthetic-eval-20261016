import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateActor(actor) {
  if (!hasExactKeys(actor, ['tenant', 'role'])
      || !nonemptyString(actor.tenant)
      || (actor.role !== 'admin' && actor.role !== 'reader')) {
    fail('AUTH', 'Invalid actor');
  }
  return actor;
}

function requireAdmin(actor) {
  validateActor(actor);
  if (actor.role !== 'admin') fail('FORBIDDEN', 'Mutation requires admin role');
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
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reservation_inventory (
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        available INTEGER NOT NULL,
        unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reservation_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reservation_records_tenant_sequence
        ON reservation_records (tenant, sequence);
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

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original operation error if SQLite already rolled back.
      }
      throw error;
    }
  }

  replayOrConflict(tenant, operation, key, canonicalInput) {
    const row = this.db.prepare(`
      SELECT canonical_input, result_json
      FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.canonical_input !== canonicalInput) {
      fail('CONFLICT', 'Idempotency key was used with different input');
    }
    return JSON.parse(row.result_json);
  }

  remember(tenant, operation, key, canonicalInput, result) {
    this.db.prepare(`
      INSERT INTO reservation_idempotency
        (tenant, operation, idempotency_key, canonical_input, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  seed(actor, input) {
    requireAdmin(actor);
    if (!hasExactKeys(input, ['sku', 'available', 'unitCents'])
        || !nonemptyString(input.sku)
        || !safeInteger(input.available)
        || !safeInteger(input.unitCents)) {
      fail('VALIDATION', 'Invalid seed input');
    }

    this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, input.sku);
      if (existing) fail('CONFLICT', 'SKU already exists');
      this.db.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(actor.tenant, input.sku, input.available, input.unitCents);
    });
  }

  reserve(actor, input) {
    requireAdmin(actor);
    if (!hasExactKeys(input, ['key', 'sku', 'quantity'])
        || !nonemptyString(input.key)
        || !nonemptyString(input.sku)
        || !safeInteger(input.quantity, 1)) {
      fail('VALIDATION', 'Invalid reserve input');
    }
    const canonicalInput = JSON.stringify({ sku: input.sku, quantity: input.quantity });

    return this.transaction(() => {
      const replay = this.replayOrConflict(actor.tenant, 'reserve', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const inventory = this.db.prepare(`
        SELECT available, unit_cents
        FROM reservation_inventory
        WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, input.sku);
      if (!inventory) fail('NOT_FOUND', 'SKU not found');
      if (input.quantity > Math.floor(MAX_SAFE / Math.max(1, inventory.unit_cents))) {
        fail('VALIDATION', 'Reservation amount exceeds safe integer range');
      }
      if (inventory.available < input.quantity) fail('CONFLICT', 'Insufficient inventory');

      const result = {
        id: randomUUID(),
        tenant: actor.tenant,
        sku: input.sku,
        quantity: input.quantity,
        amountCents: input.quantity * inventory.unit_cents,
        status: 'reserved',
        version: 1,
      };
      this.db.prepare(`
        UPDATE reservation_inventory
        SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(input.quantity, actor.tenant, input.sku);
      this.db.prepare(`
        INSERT INTO reservation_records
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, result.tenant, result.sku, result.quantity, result.amountCents);
      this.remember(actor.tenant, 'reserve', input.key, canonicalInput, result);
      return result;
    });
  }

  cancel(actor, input) {
    requireAdmin(actor);
    if (!hasExactKeys(input, ['key', 'id', 'expectedVersion'])
        || !nonemptyString(input.key)
        || !nonemptyString(input.id)
        || !safeInteger(input.expectedVersion, 1)) {
      fail('VALIDATION', 'Invalid cancel input');
    }
    const canonicalInput = JSON.stringify({ id: input.id, expectedVersion: input.expectedVersion });

    return this.transaction(() => {
      const replay = this.replayOrConflict(actor.tenant, 'cancel', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.db.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_records
        WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (!row) fail('NOT_FOUND', 'Reservation not found');
      if (row.version !== input.expectedVersion) fail('CONFLICT', 'Stale reservation version');
      if (row.status !== 'reserved') fail('CONFLICT', 'Reservation cannot be canceled');

      this.db.prepare(`
        UPDATE reservation_records
        SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(actor.tenant, input.id);
      this.db.prepare(`
        UPDATE reservation_inventory
        SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, actor.tenant, row.sku);
      const result = publicReservation({ ...row, status: 'canceled', version: row.version + 1 });
      this.remember(actor.tenant, 'cancel', input.key, canonicalInput, result);
      return result;
    });
  }

  inventory(actor, sku) {
    validateActor(actor);
    if (!nonemptyString(sku)) fail('VALIDATION', 'Invalid SKU');
    const row = this.db.prepare(`
      SELECT sku, available, unit_cents
      FROM reservation_inventory
      WHERE tenant = ? AND sku = ?
    `).get(actor.tenant, sku);
    if (!row) fail('NOT_FOUND', 'SKU not found');
    return { sku: row.sku, available: row.available, unitCents: row.unit_cents };
  }

  get(actor, id) {
    validateActor(actor);
    if (!nonemptyString(id)) fail('VALIDATION', 'Invalid reservation ID');
    const row = this.db.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_records
      WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) fail('NOT_FOUND', 'Reservation not found');
    return publicReservation(row);
  }

  list(actor, input) {
    validateActor(actor);
    if (!hasExactKeys(input, ['page', 'pageSize'])
        || !safeInteger(input.page, 1)
        || !safeInteger(input.pageSize, 1)
        || input.pageSize > 50) {
      fail('VALIDATION', 'Invalid pagination');
    }
    const total = this.db.prepare(`
      SELECT COUNT(*) AS total FROM reservation_records WHERE tenant = ?
    `).get(actor.tenant).total;
    if (input.page > Math.floor(MAX_SAFE / input.pageSize)) return { items: [], total };
    const offset = (input.page - 1) * input.pageSize;
    const rows = this.db.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_records
      WHERE tenant = ?
      ORDER BY sequence ASC
      LIMIT ? OFFSET ?
    `).all(actor.tenant, input.pageSize, offset);
    return { items: rows.map(publicReservation), total };
  }

  close() {
    this.db.close();
  }
}
