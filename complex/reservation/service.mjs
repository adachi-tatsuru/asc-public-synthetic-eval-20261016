import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new ServiceError(code, message);
};

const hasExactKeys = (value, expected) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) return false;
  keys.sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const isNonemptyString = value => typeof value === 'string' && value.length > 0;
const isSafeIntegerAtLeast = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;

const checkActor = (actor, mutate = false) => {
  if (
    !hasExactKeys(actor, ['tenant', 'role']) ||
    !isNonemptyString(actor.tenant) || (actor.role !== 'admin' && actor.role !== 'reader')
  ) fail('AUTH', 'Invalid actor');
  if (mutate && actor.role !== 'admin') fail('FORBIDDEN', 'Mutation is not permitted');
};

const checkId = id => {
  if (!isNonemptyString(id)) fail('VALIDATION', 'Invalid id');
};

const publicReservation = row => Object.freeze({
  id: row.id,
  tenant: row.tenant,
  sku: row.sku,
  quantity: row.quantity,
  amountCents: row.amount_cents,
  status: row.status,
  version: row.version,
  currency: 'JPY',
});

export class ReservationService {
  #db;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
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
        key TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, key)
      );
    `);
  }

  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Preserve the error that caused the transaction to fail.
      }
      throw error;
    }
  }

  #replay(tenant, operation, key, input) {
    const row = this.#db.prepare(`
      SELECT input, result FROM reservation_idempotency
      WHERE tenant = ? AND operation = ? AND key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.input !== input) fail('CONFLICT', 'Idempotency key was used with different input');
    return Object.freeze({...JSON.parse(row.result), currency: 'JPY'});
  }

  #record(tenant, operation, key, input, result) {
    this.#db.prepare(`
      INSERT INTO reservation_idempotency (tenant, operation, key, input, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, input, JSON.stringify(result));
  }

  seed(actor, input) {
    checkActor(actor, true);
    if (!hasExactKeys(input, ['sku', 'available', 'unitCents'])) fail('VALIDATION', 'Invalid seed input');
    const {sku, available, unitCents} = input;
    if (!isNonemptyString(sku) || !isSafeIntegerAtLeast(available, 0) || !isSafeIntegerAtLeast(unitCents, 0)) {
      fail('VALIDATION', 'Invalid seed input');
    }

    return this.#transaction(() => {
      const existing = this.#db.prepare(`
        SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, sku);
      if (existing) fail('CONFLICT', 'SKU already exists');
      this.#db.prepare(`
        INSERT INTO reservation_inventory (tenant, sku, available, unit_cents)
        VALUES (?, ?, ?, ?)
      `).run(actor.tenant, sku, available, unitCents);
    });
  }

  reserve(actor, input) {
    checkActor(actor, true);
    if (!hasExactKeys(input, ['key', 'sku', 'quantity'])) fail('VALIDATION', 'Invalid reserve input');
    const {key, sku, quantity} = input;
    if (!isNonemptyString(key) || !isNonemptyString(sku) || !isSafeIntegerAtLeast(quantity, 1)) {
      fail('VALIDATION', 'Invalid reserve input');
    }
    const canonical = JSON.stringify({sku, quantity});

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, 'reserve', key, canonical);
      if (replay) return replay;

      const inventory = this.#db.prepare(`
        SELECT available, unit_cents FROM reservation_inventory WHERE tenant = ? AND sku = ?
      `).get(actor.tenant, sku);
      if (!inventory) fail('NOT_FOUND', 'SKU not found');
      if (inventory.available < quantity) fail('CONFLICT', 'Insufficient inventory');
      const amountCents = quantity * inventory.unit_cents;
      if (!Number.isSafeInteger(amountCents)) fail('VALIDATION', 'Reservation amount is unsafe');

      const result = Object.freeze({
        id: randomUUID(),
        tenant: actor.tenant,
        sku,
        quantity,
        amountCents,
        status: 'reserved',
        version: 1,
        currency: 'JPY',
      });
      this.#db.prepare(`
        UPDATE reservation_inventory SET available = available - ?
        WHERE tenant = ? AND sku = ?
      `).run(quantity, actor.tenant, sku);
      this.#db.prepare(`
        INSERT INTO reservation_resources
          (id, tenant, sku, quantity, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, 'reserved', 1)
      `).run(result.id, result.tenant, result.sku, result.quantity, result.amountCents);
      this.#record(actor.tenant, 'reserve', key, canonical, result);
      return result;
    });
  }

  cancel(actor, input) {
    checkActor(actor, true);
    if (!hasExactKeys(input, ['key', 'id', 'expectedVersion'])) fail('VALIDATION', 'Invalid cancel input');
    const {key, id, expectedVersion} = input;
    if (!isNonemptyString(key) || !isNonemptyString(id) || !isSafeIntegerAtLeast(expectedVersion, 1)) {
      fail('VALIDATION', 'Invalid cancel input');
    }
    const canonical = JSON.stringify({id, expectedVersion});

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, 'cancel', key, canonical);
      if (replay) return replay;

      const row = this.#db.prepare(`
        SELECT id, tenant, sku, quantity, amount_cents, status, version
        FROM reservation_resources WHERE tenant = ? AND id = ?
      `).get(actor.tenant, id);
      if (!row) fail('NOT_FOUND', 'Reservation not found');
      if (row.version !== expectedVersion || row.status !== 'reserved') {
        fail('CONFLICT', 'Reservation cannot be canceled');
      }

      this.#db.prepare(`
        UPDATE reservation_resources SET status = 'canceled', version = version + 1
        WHERE tenant = ? AND id = ?
      `).run(actor.tenant, id);
      this.#db.prepare(`
        UPDATE reservation_inventory SET available = available + ?
        WHERE tenant = ? AND sku = ?
      `).run(row.quantity, actor.tenant, row.sku);
      const result = Object.freeze({...publicReservation(row), status: 'canceled', version: row.version + 1});
      this.#record(actor.tenant, 'cancel', key, canonical, result);
      return result;
    });
  }

  inventory(actor, sku) {
    checkActor(actor);
    if (!isNonemptyString(sku)) fail('VALIDATION', 'Invalid SKU');
    const row = this.#db.prepare(`
      SELECT sku, available, unit_cents FROM reservation_inventory WHERE tenant = ? AND sku = ?
    `).get(actor.tenant, sku);
    if (!row) fail('NOT_FOUND', 'SKU not found');
    return Object.freeze({sku: row.sku, available: row.available, unitCents: row.unit_cents});
  }

  get(actor, id) {
    checkActor(actor);
    checkId(id);
    const row = this.#db.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) fail('NOT_FOUND', 'Reservation not found');
    return publicReservation(row);
  }

  list(actor, input) {
    checkActor(actor);
    if (!hasExactKeys(input, ['page', 'pageSize'])) fail('VALIDATION', 'Invalid list input');
    const {page, pageSize} = input;
    if (!isSafeIntegerAtLeast(page, 1) || !isSafeIntegerAtLeast(pageSize, 1) || pageSize > 50) {
      fail('VALIDATION', 'Invalid list input');
    }
    const {total} = this.#db.prepare(`
      SELECT COUNT(*) AS total FROM reservation_resources WHERE tenant = ?
    `).get(actor.tenant);
    if (page - 1 > Math.floor(Number.MAX_SAFE_INTEGER / pageSize)) {
      return {items: [], total};
    }
    const offset = (page - 1) * pageSize;
    const rows = this.#db.prepare(`
      SELECT id, tenant, sku, quantity, amount_cents, status, version
      FROM reservation_resources WHERE tenant = ? ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(actor.tenant, pageSize, offset);
    return {items: rows.map(publicReservation), total};
  }

  close() {
    this.#db.close();
  }
}
