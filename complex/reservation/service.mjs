import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

function makeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function ownKeys(obj) {
  return [...Object.getOwnPropertyNames(obj), ...Object.getOwnPropertySymbols(obj)];
}

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isSafeIntAtLeast = (min) => (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const isSafeIntInRange = (min, max) => (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

// Validates that `input` is a plain object with EXACTLY the given fields (own
// string keys + own symbol keys), each satisfying its validator. Rejects
// anything else (wrong type, missing keys, extra/unknown keys including
// non-enumerable and symbol-keyed ones) with a VALIDATION error.
function requireShape(input, fields) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw makeError('VALIDATION', 'input must be an object');
  }
  const keys = ownKeys(input);
  const required = fields.map(([name]) => name);
  if (keys.length !== required.length) {
    throw makeError('VALIDATION', 'unexpected or missing keys');
  }
  const result = {};
  for (const [name, validator] of fields) {
    if (!Object.prototype.hasOwnProperty.call(input, name)) {
      throw makeError('VALIDATION', `missing key ${String(name)}`);
    }
    const value = input[name];
    if (!validator(value)) {
      throw makeError('VALIDATION', `invalid value for ${String(name)}`);
    }
    result[name] = value;
  }
  return result;
}

function requireActor(actor) {
  if (actor === null || typeof actor !== 'object') throw makeError('AUTH', 'invalid actor');
  const { tenant, role } = actor;
  if (typeof tenant !== 'string' || tenant.length === 0) throw makeError('AUTH', 'invalid tenant');
  if (role !== 'admin' && role !== 'reader') throw makeError('AUTH', 'invalid role');
  return { tenant, role };
}

function requireAdmin(actor) {
  const a = requireActor(actor);
  if (a.role !== 'admin') throw makeError('FORBIDDEN', 'mutation requires admin role');
  return a;
}

function canonicalEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const CURRENCY = 'JPY';

export class ReservationService {
  #db;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS reservation_inventory (
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        available INTEGER NOT NULL,
        unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      );
      CREATE TABLE IF NOT EXISTS reservation_resources (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reservation_idempotency_records (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idem_key)
      );
    `);
  }

  close() {
    this.#db.close();
  }

  #transact(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = fn();
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    this.#db.exec('COMMIT');
    return result;
  }

  #findIdempotent(tenant, operation, key) {
    const row = this.#db
      .prepare('SELECT input_json, result_json FROM reservation_idempotency_records WHERE tenant = ? AND operation = ? AND idem_key = ?')
      .get(tenant, operation, key);
    if (!row) return undefined;
    return { input: JSON.parse(row.input_json), result: JSON.parse(row.result_json) };
  }

  #saveIdempotent(tenant, operation, key, input, result) {
    this.#db
      .prepare('INSERT INTO reservation_idempotency_records (tenant, operation, idem_key, input_json, result_json) VALUES (?, ?, ?, ?, ?)')
      .run(tenant, operation, key, JSON.stringify(input), JSON.stringify(result));
  }

  #toPublic(row) {
    return Object.freeze({
      id: row.id,
      tenant: row.tenant,
      sku: row.sku,
      quantity: row.quantity,
      amountCents: row.amount_cents,
      status: row.status,
      version: row.version,
      currency: CURRENCY,
    });
  }

  seed(actor, input) {
    const a = requireAdmin(actor);
    const { sku, available, unitCents } = requireShape(input, [
      ['sku', isNonEmptyString],
      ['available', isSafeIntAtLeast(0)],
      ['unitCents', isSafeIntAtLeast(0)],
    ]);
    this.#transact(() => {
      const existing = this.#db
        .prepare('SELECT 1 FROM reservation_inventory WHERE tenant = ? AND sku = ?')
        .get(a.tenant, sku);
      if (existing) throw makeError('CONFLICT', 'sku already seeded');
      this.#db
        .prepare('INSERT INTO reservation_inventory (tenant, sku, available, unit_cents) VALUES (?, ?, ?, ?)')
        .run(a.tenant, sku, available, unitCents);
    });
    return undefined;
  }

  reserve(actor, input) {
    const a = requireAdmin(actor);
    const { key, sku, quantity } = requireShape(input, [
      ['key', isNonEmptyString],
      ['sku', isNonEmptyString],
      ['quantity', isSafeIntAtLeast(1)],
    ]);
    const canonicalInput = { sku, quantity };
    return this.#transact(() => {
      const existing = this.#findIdempotent(a.tenant, 'reserve', key);
      if (existing) {
        if (!canonicalEqual(existing.input, canonicalInput)) {
          throw makeError('CONFLICT', 'idempotency key reused with different input');
        }
        return Object.freeze({ ...existing.result, currency: CURRENCY });
      }
      const inv = this.#db
        .prepare('SELECT available, unit_cents FROM reservation_inventory WHERE tenant = ? AND sku = ?')
        .get(a.tenant, sku);
      if (!inv) throw makeError('NOT_FOUND', 'unknown sku');
      if (quantity > inv.available) throw makeError('CONFLICT', 'insufficient inventory');
      const amountCents = quantity * inv.unit_cents;
      if (!Number.isSafeInteger(amountCents)) throw makeError('VALIDATION', 'amount exceeds safe integer range');
      const id = randomUUID();
      this.#db
        .prepare('INSERT INTO reservation_resources (id, tenant, sku, quantity, amount_cents, status, version) VALUES (?, ?, ?, ?, ?, ?, 1)')
        .run(id, a.tenant, sku, quantity, amountCents, 'reserved');
      this.#db
        .prepare('UPDATE reservation_inventory SET available = available - ? WHERE tenant = ? AND sku = ?')
        .run(quantity, a.tenant, sku);
      const result = { id, tenant: a.tenant, sku, quantity, amountCents, status: 'reserved', version: 1, currency: CURRENCY };
      this.#saveIdempotent(a.tenant, 'reserve', key, canonicalInput, result);
      return Object.freeze({ ...result });
    });
  }

  cancel(actor, input) {
    const a = requireAdmin(actor);
    const { key, id, expectedVersion } = requireShape(input, [
      ['key', isNonEmptyString],
      ['id', isNonEmptyString],
      ['expectedVersion', isSafeIntAtLeast(1)],
    ]);
    const canonicalInput = { id, expectedVersion };
    return this.#transact(() => {
      const existing = this.#findIdempotent(a.tenant, 'cancel', key);
      if (existing) {
        if (!canonicalEqual(existing.input, canonicalInput)) {
          throw makeError('CONFLICT', 'idempotency key reused with different input');
        }
        return Object.freeze({ ...existing.result, currency: CURRENCY });
      }
      const row = this.#db
        .prepare('SELECT * FROM reservation_resources WHERE tenant = ? AND id = ?')
        .get(a.tenant, id);
      if (!row) throw makeError('NOT_FOUND', 'unknown reservation');
      if (row.status !== 'reserved' || row.version !== expectedVersion) {
        throw makeError('CONFLICT', 'reservation not cancelable at expected version');
      }
      const newVersion = row.version + 1;
      this.#db
        .prepare('UPDATE reservation_resources SET status = ?, version = ? WHERE tenant = ? AND id = ?')
        .run('canceled', newVersion, a.tenant, id);
      this.#db
        .prepare('UPDATE reservation_inventory SET available = available + ? WHERE tenant = ? AND sku = ?')
        .run(row.quantity, a.tenant, row.sku);
      const result = {
        id: row.id,
        tenant: a.tenant,
        sku: row.sku,
        quantity: row.quantity,
        amountCents: row.amount_cents,
        status: 'canceled',
        version: newVersion,
        currency: CURRENCY,
      };
      this.#saveIdempotent(a.tenant, 'cancel', key, canonicalInput, result);
      return Object.freeze({ ...result });
    });
  }

  inventory(actor, sku) {
    const a = requireActor(actor);
    if (typeof sku !== 'string' || sku.length === 0) throw makeError('NOT_FOUND', 'unknown sku');
    const row = this.#db
      .prepare('SELECT available, unit_cents FROM reservation_inventory WHERE tenant = ? AND sku = ?')
      .get(a.tenant, sku);
    if (!row) throw makeError('NOT_FOUND', 'unknown sku');
    return Object.freeze({ sku, available: row.available, unitCents: row.unit_cents });
  }

  get(actor, id) {
    const a = requireActor(actor);
    if (typeof id !== 'string' || id.length === 0) throw makeError('NOT_FOUND', 'unknown id');
    const row = this.#db
      .prepare('SELECT * FROM reservation_resources WHERE tenant = ? AND id = ?')
      .get(a.tenant, id);
    if (!row) throw makeError('NOT_FOUND', 'unknown id');
    return this.#toPublic(row);
  }

  list(actor, input) {
    const a = requireActor(actor);
    const { page, pageSize } = requireShape(input, [
      ['page', isSafeIntAtLeast(1)],
      ['pageSize', isSafeIntInRange(1, 50)],
    ]);
    const totalRow = this.#db
      .prepare('SELECT COUNT(*) as c FROM reservation_resources WHERE tenant = ?')
      .get(a.tenant);
    const total = totalRow.c;
    const offset = (page - 1) * pageSize;
    const rows = this.#db
      .prepare('SELECT * FROM reservation_resources WHERE tenant = ? ORDER BY seq ASC LIMIT ? OFFSET ?')
      .all(a.tenant, pageSize, offset);
    const items = Object.freeze(rows.map((row) => this.#toPublic(row)));
    return Object.freeze({ items, total });
  }
}
