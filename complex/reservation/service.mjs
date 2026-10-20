/** Issue R: tenant-scoped reservation service persisted in SQLite (tables prefixed `reservation_`). */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';

const BUSY_TIMEOUT_MS = 5000;
const MAX_PAGE_SIZE = 50;

class ReservationError extends Error {
  constructor(code, message) { super(message); this.name = 'ReservationError'; this.code = code; }
}
const fail = (code, message) => { throw new ReservationError(code, message); };

/** Validate the actor without trusting accessors; returns a fresh {tenant, role}. */
function readActor(actor) {
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor) || types.isProxy(actor)) {
    fail('AUTH', 'Actor must be an object {tenant, role} with role admin or reader');
  }
  const value = name => {
    const d = Object.getOwnPropertyDescriptor(actor, name);
    return d && Object.hasOwn(d, 'value') ? d.value : undefined;
  };
  const tenant = value('tenant'), role = value('role');
  if (typeof tenant !== 'string' || tenant.length === 0) fail('AUTH', 'Actor tenant must be a nonempty string');
  if (role !== 'admin' && role !== 'reader') fail('AUTH', 'Actor role must be admin or reader');
  return { tenant, role };
}

function requireAdmin(actor, action) {
  if (actor.role !== 'admin') fail('FORBIDDEN', `Readers may not ${action}; use an admin session`);
}

/**
 * Snapshot a plain input object with exactly `keys` as own data properties
 * (including non-enumerable and symbol keys). Each value is read exactly once.
 */
function snapshot(input, keys, what) {
  const shape = `${what} must be a plain object with exactly ${keys.join(', ')}`;
  if (input === null || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)) fail('VALIDATION', shape);
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) fail('VALIDATION', shape);
  const own = Reflect.ownKeys(input);
  const unexpected = own.filter(k => typeof k !== 'string' || !keys.includes(k));
  if (unexpected.length) fail('VALIDATION', `${shape} (unexpected ${unexpected.map(String).join(', ')})`);
  const out = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d) fail('VALIDATION', `${shape} (missing ${key})`);
    if (!Object.hasOwn(d, 'value')) fail('VALIDATION', `${what}.${key} must be a plain data value, not an accessor`);
    out[key] = d.value;
  }
  return out;
}

function text(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail('VALIDATION', `${name} must be a nonempty string`);
  return value;
}
function int(value, name, min) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail('VALIDATION', `${name} must be a safe integer >= ${min} (numeric strings are not accepted)`);
  }
  return value;
}

const publicReservation = row => Object.freeze({
  id: row.id, tenant: row.tenant, sku: row.sku, quantity: row.quantity,
  amountCents: row.amount_cents, status: row.status, version: row.version,
});
const publicInventory = row => Object.freeze({ sku: row.sku, available: row.available, unitCents: row.unit_cents });
const freezeCopy = obj => Object.freeze({ ...obj });

export class ReservationService {
  #db;
  #st;

  constructor(filename) {
    if (typeof filename !== 'string' || filename.length === 0) throw new TypeError('ReservationService requires a SQLite filename');
    this.#db = new DatabaseSync(filename, { timeout: BUSY_TIMEOUT_MS });
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS reservation_inventory (
        tenant TEXT NOT NULL, sku TEXT NOT NULL,
        available INTEGER NOT NULL, unit_cents INTEGER NOT NULL,
        PRIMARY KEY (tenant, sku)
      );
      CREATE TABLE IF NOT EXISTS reservation_items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL, sku TEXT NOT NULL,
        quantity INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reservation_items_tenant ON reservation_items (tenant, seq);
      CREATE TABLE IF NOT EXISTS reservation_idempotency (
        tenant TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
        input TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, key)
      );
    `);
    const p = sql => this.#db.prepare(sql);
    this.#st = {
      inventory: p('SELECT sku, available, unit_cents FROM reservation_inventory WHERE tenant = ? AND sku = ?'),
      insertInventory: p('INSERT INTO reservation_inventory (tenant, sku, available, unit_cents) VALUES (?, ?, ?, ?)'),
      adjustInventory: p('UPDATE reservation_inventory SET available = available + ? WHERE tenant = ? AND sku = ?'),
      item: p('SELECT * FROM reservation_items WHERE tenant = ? AND id = ?'),
      insertItem: p('INSERT INTO reservation_items (id, tenant, sku, quantity, amount_cents, status, version) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      updateItem: p('UPDATE reservation_items SET status = ?, version = ? WHERE tenant = ? AND id = ? AND version = ?'),
      count: p('SELECT COUNT(*) AS total FROM reservation_items WHERE tenant = ?'),
      page: p('SELECT * FROM reservation_items WHERE tenant = ? ORDER BY seq LIMIT ? OFFSET ?'),
      idem: p('SELECT input, result FROM reservation_idempotency WHERE tenant = ? AND operation = ? AND key = ?'),
      insertIdem: p('INSERT INTO reservation_idempotency (tenant, operation, key, input, result) VALUES (?, ?, ?, ?, ?)'),
    };
  }

  #open() {
    if (!this.#db || !this.#db.isOpen) throw new Error('Reservation service is closed; reopen it before use');
    return this.#st;
  }

  /** Run fn inside BEGIN IMMEDIATE; any throw rolls back so state is unchanged. */
  #write(fn) {
    const st = this.#open();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(st);
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  /** Idempotent keyed mutation: replay same canonical input, CONFLICT on different input. */
  #keyed(st, tenant, operation, key, canonical, perform) {
    const prior = st.idem.get(tenant, operation, key);
    if (prior) {
      if (prior.input !== canonical) fail('CONFLICT', `Key ${JSON.stringify(key)} was already used for a different ${operation}; use a new key for a new operation`);
      return freezeCopy(JSON.parse(prior.result));
    }
    const result = perform();
    st.insertIdem.run(tenant, operation, key, canonical, JSON.stringify(result));
    return result;
  }

  seed(actor, input) {
    const a = readActor(actor);
    requireAdmin(a, 'seed inventory');
    const v = snapshot(input, ['sku', 'available', 'unitCents'], 'Seed input');
    const sku = text(v.sku, 'sku');
    const available = int(v.available, 'available', 0);
    const unitCents = int(v.unitCents, 'unitCents', 0);
    this.#write(st => {
      if (st.inventory.get(a.tenant, sku)) fail('CONFLICT', `SKU ${JSON.stringify(sku)} is already seeded; seeding never overwrites inventory`);
      st.insertInventory.run(a.tenant, sku, available, unitCents);
    });
  }

  reserve(actor, input) {
    const a = readActor(actor);
    requireAdmin(a, 'reserve');
    const v = snapshot(input, ['key', 'sku', 'quantity'], 'Reserve input');
    const key = text(v.key, 'key');
    const sku = text(v.sku, 'sku');
    const quantity = int(v.quantity, 'quantity', 1);
    const canonical = JSON.stringify([sku, quantity]);
    return this.#write(st => this.#keyed(st, a.tenant, 'reserve', key, canonical, () => {
      const inv = st.inventory.get(a.tenant, sku);
      if (!inv) fail('NOT_FOUND', `Unknown SKU ${JSON.stringify(sku)}; seed it before reserving`);
      const amountCents = quantity * inv.unit_cents;
      if (!Number.isSafeInteger(amountCents)) fail('VALIDATION', `quantity ${quantity} × unitCents ${inv.unit_cents} exceeds the safe integer range; reserve fewer units`);
      if (inv.available < quantity) fail('CONFLICT', `Only ${inv.available} of SKU ${JSON.stringify(sku)} available; reduce quantity`);
      const row = { id: randomUUID(), tenant: a.tenant, sku, quantity, amount_cents: amountCents, status: 'reserved', version: 1 };
      st.adjustInventory.run(-quantity, a.tenant, sku);
      st.insertItem.run(row.id, row.tenant, row.sku, row.quantity, row.amount_cents, row.status, row.version);
      return publicReservation(row);
    }));
  }

  cancel(actor, input) {
    const a = readActor(actor);
    requireAdmin(a, 'cancel reservations');
    const v = snapshot(input, ['key', 'id', 'expectedVersion'], 'Cancel input');
    const key = text(v.key, 'key');
    const id = text(v.id, 'id');
    const expectedVersion = int(v.expectedVersion, 'expectedVersion', 1);
    const canonical = JSON.stringify([id, expectedVersion]);
    return this.#write(st => this.#keyed(st, a.tenant, 'cancel', key, canonical, () => {
      const row = st.item.get(a.tenant, id);
      if (!row) fail('NOT_FOUND', `Reservation ${JSON.stringify(id)} not found`);
      if (row.version !== expectedVersion) fail('CONFLICT', `Reservation is at version ${row.version}, not ${expectedVersion}; reload and retry`);
      if (row.status !== 'reserved') fail('CONFLICT', `Reservation is ${row.status}; only reserved reservations can be canceled`);
      const next = { ...row, status: 'canceled', version: row.version + 1 };
      const changed = st.updateItem.run(next.status, next.version, a.tenant, id, expectedVersion);
      if (Number(changed.changes) !== 1) fail('CONFLICT', 'Reservation changed concurrently; reload and retry');
      st.adjustInventory.run(row.quantity, a.tenant, row.sku);
      return publicReservation(next);
    }));
  }

  get(actor, id) {
    const a = readActor(actor);
    text(id, 'id');
    const row = this.#open().item.get(a.tenant, id);
    if (!row) fail('NOT_FOUND', `Reservation ${JSON.stringify(id)} not found`);
    return publicReservation(row);
  }

  list(actor, query) {
    const a = readActor(actor);
    const v = snapshot(query, ['page', 'pageSize'], 'List query');
    const page = int(v.page, 'page', 1);
    const pageSize = int(v.pageSize, 'pageSize', 1);
    if (pageSize > MAX_PAGE_SIZE) fail('VALIDATION', `pageSize must be <= ${MAX_PAGE_SIZE}`);
    const st = this.#open();
    const total = Number(st.count.get(a.tenant).total);
    const pagesBefore = page - 1;
    if (pagesBefore >= Math.ceil(total / pageSize)) return Object.freeze({ items: Object.freeze([]), total });
    const items = st.page.all(a.tenant, pageSize, pagesBefore * pageSize).map(publicReservation);
    return Object.freeze({ items: Object.freeze(items), total });
  }

  inventory(actor, sku) {
    const a = readActor(actor);
    text(sku, 'sku');
    const row = this.#open().inventory.get(a.tenant, sku);
    if (!row) fail('NOT_FOUND', `Unknown SKU ${JSON.stringify(sku)}`);
    return publicInventory(row);
  }

  close() {
    if (this.#db?.isOpen) this.#db.close();
  }
}
