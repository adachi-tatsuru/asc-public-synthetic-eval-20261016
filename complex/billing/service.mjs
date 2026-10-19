import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function snapshot(value, names) {
  if (value === null || typeof value !== 'object') throw failure('VALIDATION');
  try {
    if (Array.isArray(value)) throw failure('VALIDATION');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) throw failure('VALIDATION');
    const result = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure('VALIDATION');
      result[name] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error?.code === 'VALIDATION') throw error;
    throw failure('VALIDATION');
  }
}

const nonempty = value => typeof value === 'string' && value.length > 0;
const integer = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;

function actorSnapshot(actor, mutation = false) {
  if (actor === null || typeof actor !== 'object') throw failure('AUTH');
  let tenant, role;
  try {
    if (Array.isArray(actor)) throw failure('AUTH');
    tenant = actor.tenant;
    role = actor.role;
  } catch {
    throw failure('AUTH');
  }
  if (!nonempty(tenant) || (role !== 'admin' && role !== 'reader')) throw failure('AUTH');
  if (mutation && role !== 'admin') throw failure('FORBIDDEN');
  return tenant;
}

function invoice(row) {
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
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS billing_invoices (
        id TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_order INTEGER NOT NULL,
        UNIQUE (tenant, reservation_id)
      );
      CREATE TABLE IF NOT EXISTS billing_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        key TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, key)
      );
    `);
    this.replay = this.db.prepare('SELECT input, result FROM billing_idempotency WHERE tenant = ? AND operation = ? AND key = ?');
    this.record = this.db.prepare('INSERT INTO billing_idempotency (tenant, operation, key, input, result) VALUES (?, ?, ?, ?, ?)');
    this.byId = this.db.prepare('SELECT * FROM billing_invoices WHERE tenant = ? AND id = ?');
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  apply(tenant, operation, key, canonical, action) {
    return this.transaction(() => {
      const previous = this.replay.get(tenant, operation, key);
      if (previous) {
        if (previous.input !== canonical) throw failure('CONFLICT');
        return JSON.parse(previous.result);
      }
      const result = action();
      this.record.run(tenant, operation, key, canonical, JSON.stringify(result));
      return result;
    });
  }

  issue(actor, input) {
    const tenant = actorSnapshot(actor, true);
    const request = snapshot(input, ['key', 'event']);
    if (!nonempty(request.key)) throw failure('VALIDATION');
    const event = snapshot(request.event, ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version']);
    if (!nonempty(event.id) || !nonempty(event.tenant) || !nonempty(event.sku) ||
        !integer(event.quantity, 1) || !integer(event.amountCents, 0) ||
        event.status !== 'reserved' || !integer(event.version, 1)) throw failure('VALIDATION');
    if (event.tenant !== tenant) throw failure('FORBIDDEN');
    const canonical = JSON.stringify([event.id, event.tenant, event.sku, event.quantity,
      event.amountCents, event.status, event.version]);
    return this.apply(tenant, 'issue', request.key, canonical, () => {
      if (this.db.prepare('SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?').get(tenant, event.id)) throw failure('CONFLICT');
      const id = randomUUID();
      const order = this.db.prepare('SELECT COALESCE(MAX(created_order), 0) + 1 AS next_order FROM billing_invoices').get().next_order;
      this.db.prepare('INSERT INTO billing_invoices (id, tenant, reservation_id, amount_cents, status, version, created_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, tenant, event.id, event.amountCents, 'open', 1, order);
      return {id, tenant, reservationId: event.id, amountCents: event.amountCents, status: 'open', version: 1};
    });
  }

  transition(operation, actor, input, from, to) {
    const tenant = actorSnapshot(actor, true);
    const request = snapshot(input, ['key', 'id', 'expectedVersion']);
    if (!nonempty(request.key) || !nonempty(request.id) || !integer(request.expectedVersion, 1)) throw failure('VALIDATION');
    const canonical = JSON.stringify([request.id, request.expectedVersion]);
    return this.apply(tenant, operation, request.key, canonical, () => {
      const row = this.byId.get(tenant, request.id);
      if (!row) throw failure('NOT_FOUND');
      if (row.version !== request.expectedVersion || row.status !== from) throw failure('CONFLICT');
      const version = row.version + 1;
      if (!Number.isSafeInteger(version)) throw failure('VALIDATION');
      this.db.prepare('UPDATE billing_invoices SET status = ?, version = ? WHERE tenant = ? AND id = ?')
        .run(to, version, tenant, request.id);
      return {...invoice(row), status: to, version};
    });
  }

  pay(actor, input) { return this.transition('pay', actor, input, 'open', 'paid'); }
  refund(actor, input) { return this.transition('refund', actor, input, 'paid', 'refunded'); }

  get(actor, id) {
    const tenant = actorSnapshot(actor);
    if (!nonempty(id)) throw failure('VALIDATION');
    const row = this.byId.get(tenant, id);
    if (!row) throw failure('NOT_FOUND');
    return invoice(row);
  }

  list(actor, input) {
    const tenant = actorSnapshot(actor);
    const request = snapshot(input, ['page', 'pageSize']);
    if (!integer(request.page, 1) || !integer(request.pageSize, 1) || request.pageSize > 50) throw failure('VALIDATION');
    const total = this.db.prepare('SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?').get(tenant).total;
    const offset = (request.page - 1) * request.pageSize;
    if (!Number.isSafeInteger(offset)) return {items: [], total};
    const rows = this.db.prepare('SELECT * FROM billing_invoices WHERE tenant = ? ORDER BY created_order LIMIT ? OFFSET ?')
      .all(tenant, request.pageSize, offset);
    return {items: rows.map(invoice), total};
  }

  close() { this.db.close(); }
}
