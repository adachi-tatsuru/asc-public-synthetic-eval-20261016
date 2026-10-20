/**
 * Issue B: billing service. Synchronous node:sqlite persistence of invoices and idempotency records.
 * Tables are namespaced `billing_` so they can share a database file with the reservation service.
 * Never imports the reservation implementation; reservation output arrives as a validated `event`.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const BUSY_TIMEOUT_MS = 5000;
const MAX_PAGE_SIZE = 50;
const EVENT_KEYS = ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version'];
const TRANSITIONS = Object.freeze({
  pay: Object.freeze({ from: 'open', to: 'paid' }),
  refund: Object.freeze({ from: 'paid', to: 'refunded' }),
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isNonEmptyString = value => typeof value === 'string' && value.length > 0;
const isSafeIntAtLeast = (value, min) => Number.isSafeInteger(value) && value >= min;

/**
 * Snapshot a plain object with exactly `keys` as own data properties. Every own key (string,
 * symbol, enumerable or not) is inspected through Reflect.ownKeys; accessors are rejected so each
 * value is read exactly once and cannot change between validation and persistence.
 */
function snapshot(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('VALIDATION', `${label} must be an object with exactly ${keys.join(', ')}`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw fail('VALIDATION', `${label} must be a plain object`);
  const own = Reflect.ownKeys(value);
  const result = {};
  for (const key of own) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      throw fail('VALIDATION', `${label} has unexpected key ${String(key)}; expected exactly ${keys.join(', ')}`);
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw fail('VALIDATION', `${label}.${key} must be a plain data property, not an accessor`);
    }
    result[key] = descriptor.value;
  }
  for (const key of keys) {
    if (!Object.hasOwn(result, key)) throw fail('VALIDATION', `${label} is missing ${key}; expected exactly ${keys.join(', ')}`);
  }
  return result;
}

function readActor(actor) {
  if (actor === null || typeof actor !== 'object') throw fail('AUTH', 'A valid actor {tenant, role} is required');
  const tenant = actor.tenant;
  const role = actor.role;
  if (!isNonEmptyString(tenant) || (role !== 'admin' && role !== 'reader')) {
    throw fail('AUTH', 'Actor must have a nonempty tenant and role admin or reader');
  }
  return { tenant, role };
}

function requireAdmin(actor) {
  if (actor.role !== 'admin') throw fail('FORBIDDEN', 'Readers may view invoices but cannot change them');
}

function requireKey(key) {
  if (!isNonEmptyString(key)) throw fail('VALIDATION', 'key must be a nonempty string');
}

function requireId(id) {
  if (!isNonEmptyString(id)) throw fail('VALIDATION', 'Invoice id must be a nonempty string');
}

function publicInvoice(row) {
  return {
    id: row.id,
    tenant: row.tenant,
    reservationId: row.reservation_id,
    amountCents: row.amount_cents,
    status: row.status,
    version: row.version,
  };
}

export class BillingService {
  #db;

  constructor(filename) {
    if (!isNonEmptyString(filename)) throw fail('VALIDATION', 'BillingService requires a SQLite filename');
    this.#db = new DatabaseSync(filename, { timeout: BUSY_TIMEOUT_MS });
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS billing_invoices (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          tenant TEXT NOT NULL,
          reservation_id TEXT NOT NULL,
          amount_cents INTEGER NOT NULL,
          status TEXT NOT NULL,
          version INTEGER NOT NULL,
          UNIQUE (tenant, reservation_id)
        );
        CREATE INDEX IF NOT EXISTS billing_invoices_tenant_seq ON billing_invoices (tenant, seq);
        CREATE TABLE IF NOT EXISTS billing_idempotency (
          tenant TEXT NOT NULL,
          operation TEXT NOT NULL,
          key TEXT NOT NULL,
          input TEXT NOT NULL,
          result TEXT NOT NULL,
          PRIMARY KEY (tenant, operation, key)
        );
      `);
    });
  }

  close() {
    if (this.#db.isOpen) this.#db.close();
  }

  /** Run fn inside BEGIN IMMEDIATE so a thrown error leaves the database unchanged. */
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Replay a stored result (same canonical input) or reject key reuse (different input). */
  #replay(tenant, operation, key, input) {
    const record = this.#db.prepare('SELECT input, result FROM billing_idempotency WHERE tenant = ? AND operation = ? AND key = ?').get(tenant, operation, key);
    if (!record) return undefined;
    if (record.input !== input) throw fail('CONFLICT', `Idempotency key ${key} was already used for a different ${operation} request; use a new key`);
    return JSON.parse(record.result);
  }

  #remember(tenant, operation, key, input, result) {
    this.#db.prepare('INSERT INTO billing_idempotency (tenant, operation, key, input, result) VALUES (?, ?, ?, ?, ?)').run(tenant, operation, key, input, JSON.stringify(result));
  }

  #find(tenant, id) {
    return this.#db.prepare('SELECT * FROM billing_invoices WHERE tenant = ? AND id = ?').get(tenant, id);
  }

  issue(actor, input) {
    const who = readActor(actor);
    requireAdmin(who);
    const { key, event: rawEvent } = snapshot(input, ['key', 'event'], 'issue input');
    requireKey(key);
    const event = snapshot(rawEvent, EVENT_KEYS, 'event');
    if (!isNonEmptyString(event.id)) throw fail('VALIDATION', 'event.id must be a nonempty string');
    if (!isNonEmptyString(event.tenant)) throw fail('VALIDATION', 'event.tenant must be a nonempty string');
    if (!isNonEmptyString(event.sku)) throw fail('VALIDATION', 'event.sku must be a nonempty string');
    if (!isSafeIntAtLeast(event.quantity, 1)) throw fail('VALIDATION', 'event.quantity must be a positive safe integer');
    if (!isSafeIntAtLeast(event.amountCents, 0)) throw fail('VALIDATION', 'event.amountCents must be a non-negative safe integer');
    if (event.status !== 'reserved') throw fail('VALIDATION', 'event.status must be reserved to issue an invoice');
    if (!isSafeIntAtLeast(event.version, 1)) throw fail('VALIDATION', 'event.version must be a safe integer >= 1');
    if (event.tenant !== who.tenant) throw fail('FORBIDDEN', 'The reservation event belongs to a different tenant');
    const canonical = JSON.stringify(EVENT_KEYS.map(k => event[k]));
    return this.#transaction(() => {
      const replayed = this.#replay(who.tenant, 'issue', key, canonical);
      if (replayed) return replayed;
      const existing = this.#db.prepare('SELECT id FROM billing_invoices WHERE tenant = ? AND reservation_id = ?').get(who.tenant, event.id);
      if (existing) throw fail('CONFLICT', `Reservation ${event.id} already has invoice ${existing.id}`);
      const invoice = { id: `inv_${randomUUID()}`, tenant: who.tenant, reservationId: event.id, amountCents: event.amountCents, status: 'open', version: 1 };
      this.#db.prepare('INSERT INTO billing_invoices (id, tenant, reservation_id, amount_cents, status, version) VALUES (?, ?, ?, ?, ?, ?)')
        .run(invoice.id, invoice.tenant, invoice.reservationId, invoice.amountCents, invoice.status, invoice.version);
      this.#remember(who.tenant, 'issue', key, canonical, invoice);
      return invoice;
    });
  }

  /**
   * HTTP-layer replay lookup for issue requests identified by {key, reservationId}. Requires admin.
   * Returns the original invoice if this tenant's issue key was used for the same reservation,
   * throws CONFLICT if it was used for a different reservation, or returns undefined if unused.
   * Lets a retried request replay even after the reservation later changed (e.g. was canceled).
   */
  replayIssue(actor, input) {
    const who = readActor(actor);
    requireAdmin(who);
    const { key, reservationId } = snapshot(input, ['key', 'reservationId'], 'replayIssue input');
    requireKey(key);
    if (!isNonEmptyString(reservationId)) throw fail('VALIDATION', 'reservationId must be a nonempty string');
    const record = this.#db.prepare('SELECT result FROM billing_idempotency WHERE tenant = ? AND operation = ? AND key = ?').get(who.tenant, 'issue', key);
    if (!record) return undefined;
    const result = JSON.parse(record.result);
    if (result.reservationId !== reservationId) {
      throw fail('CONFLICT', `Idempotency key ${key} was already used to invoice a different reservation; use a new key`);
    }
    return result;
  }

  pay(actor, input) { return this.#transition('pay', actor, input); }

  refund(actor, input) { return this.#transition('refund', actor, input); }

  #transition(operation, actor, input) {
    const who = readActor(actor);
    requireAdmin(who);
    const { key, id, expectedVersion } = snapshot(input, ['key', 'id', 'expectedVersion'], `${operation} input`);
    requireKey(key);
    requireId(id);
    if (!isSafeIntAtLeast(expectedVersion, 1)) throw fail('VALIDATION', 'expectedVersion must be a safe integer >= 1');
    const { from, to } = TRANSITIONS[operation];
    const canonical = JSON.stringify([id, expectedVersion]);
    return this.#transaction(() => {
      const replayed = this.#replay(who.tenant, operation, key, canonical);
      if (replayed) return replayed;
      const row = this.#find(who.tenant, id);
      if (!row) throw fail('NOT_FOUND', `Invoice ${id} was not found`);
      if (row.version !== expectedVersion) throw fail('CONFLICT', `Invoice ${id} is at version ${row.version}, not ${expectedVersion}; reload and retry`);
      if (row.status !== from) throw fail('CONFLICT', `Invoice ${id} is ${row.status}; only ${from} invoices can be ${to}`);
      const version = row.version + 1;
      if (!Number.isSafeInteger(version)) throw fail('CONFLICT', `Invoice ${id} version cannot be incremented`);
      this.#db.prepare('UPDATE billing_invoices SET status = ?, version = ? WHERE seq = ?').run(to, version, row.seq);
      const invoice = publicInvoice({ ...row, status: to, version });
      this.#remember(who.tenant, operation, key, canonical, invoice);
      return invoice;
    });
  }

  get(actor, id) {
    const who = readActor(actor);
    requireId(id);
    const row = this.#find(who.tenant, id);
    if (!row) throw fail('NOT_FOUND', `Invoice ${id} was not found`);
    return publicInvoice(row);
  }

  list(actor, query) {
    const who = readActor(actor);
    const { page, pageSize } = snapshot(query, ['page', 'pageSize'], 'list query');
    if (!isSafeIntAtLeast(page, 1)) throw fail('VALIDATION', 'page must be a positive safe integer');
    if (!isSafeIntAtLeast(pageSize, 1) || pageSize > MAX_PAGE_SIZE) throw fail('VALIDATION', `pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    const offset = (BigInt(page) - 1n) * BigInt(pageSize);
    const { total } = this.#db.prepare('SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?').get(who.tenant);
    const rows = this.#db.prepare('SELECT * FROM billing_invoices WHERE tenant = ? ORDER BY seq LIMIT ? OFFSET ?').all(who.tenant, pageSize, offset);
    return { items: rows.map(publicInvoice), total };
  }
}
