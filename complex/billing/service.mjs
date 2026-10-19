import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

class ServiceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = code => { throw new ServiceError(code); };

function hasExactOwnKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every(key => keys.includes(key));
}

const nonemptyString = value => typeof value === 'string' && value.length > 0;
const safeInteger = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;

function validateActor(actor) {
  if (!hasExactOwnKeys(actor, ['tenant', 'role']) ||
      !nonemptyString(actor.tenant) ||
      (actor.role !== 'admin' && actor.role !== 'reader')) fail('AUTH');
}

function authorizeMutation(actor) {
  validateActor(actor);
  if (actor.role !== 'admin') fail('FORBIDDEN');
}

function validateEvent(event) {
  const keys = ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version'];
  if (!hasExactOwnKeys(event, keys) ||
      !nonemptyString(event.id) ||
      !nonemptyString(event.tenant) ||
      !nonemptyString(event.sku) ||
      !safeInteger(event.quantity, 1) ||
      !safeInteger(event.amountCents, 0) ||
      event.status !== 'reserved' ||
      !safeInteger(event.version, 1)) fail('VALIDATION');
}

function validateIssueInput(input) {
  if (!hasExactOwnKeys(input, ['key', 'event']) || !nonemptyString(input.key)) fail('VALIDATION');
  validateEvent(input.event);
}

function validateTransitionInput(input) {
  if (!hasExactOwnKeys(input, ['key', 'id', 'expectedVersion']) ||
      !nonemptyString(input.key) || !nonemptyString(input.id) ||
      !safeInteger(input.expectedVersion, 1)) fail('VALIDATION');
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
  #database;

  constructor(filename) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS billing_invoices (
        creation_order INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        UNIQUE (tenant, reservation_id)
      );
      CREATE INDEX IF NOT EXISTS billing_invoices_tenant_creation
        ON billing_invoices (tenant, creation_order);
      CREATE TABLE IF NOT EXISTS billing_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
    `);
  }

  #transaction(work) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  #replay(tenant, operation, key, requestJson) {
    const row = this.#database.prepare(`
      SELECT request_json, result_json FROM billing_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    if (!row) return undefined;
    if (row.request_json !== requestJson) fail('CONFLICT');
    return JSON.parse(row.result_json);
  }

  #record(tenant, operation, key, requestJson, result) {
    this.#database.prepare(`
      INSERT INTO billing_idempotency
        (tenant, operation, idempotency_key, request_json, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, requestJson, JSON.stringify(result));
  }

  issue(actor, input) {
    authorizeMutation(actor);
    validateIssueInput(input);
    if (input.event.tenant !== actor.tenant) fail('FORBIDDEN');
    const requestJson = JSON.stringify({key: input.key, event: {
      id: input.event.id, tenant: input.event.tenant, sku: input.event.sku,
      quantity: input.event.quantity, amountCents: input.event.amountCents,
      status: input.event.status, version: input.event.version,
    }});

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, 'issue', input.key, requestJson);
      if (replay !== undefined) return replay;
      if (this.#database.prepare(`
        SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, input.event.id)) fail('CONFLICT');

      const result = {
        id: randomUUID(), tenant: actor.tenant, reservationId: input.event.id,
        amountCents: input.event.amountCents, status: 'open', version: 1,
      };
      this.#database.prepare(`
        INSERT INTO billing_invoices
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(result.id, result.tenant, result.reservationId, result.amountCents,
        result.status, result.version);
      this.#record(actor.tenant, 'issue', input.key, requestJson, result);
      return {...result};
    });
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    authorizeMutation(actor);
    validateTransitionInput(input);
    const requestJson = JSON.stringify({
      key: input.key, id: input.id, expectedVersion: input.expectedVersion,
    });

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, operation, input.key, requestJson);
      if (replay !== undefined) return replay;
      const row = this.#database.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (!row) fail('NOT_FOUND');
      if (row.version !== input.expectedVersion || row.status !== fromStatus) fail('CONFLICT');

      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) fail('VALIDATION');
      this.#database.prepare(`
        UPDATE billing_invoices SET status = ?, version = ?
        WHERE tenant = ? AND id = ?
      `).run(toStatus, nextVersion, actor.tenant, input.id);
      const result = publicInvoice({...row, status: toStatus, version: nextVersion});
      this.#record(actor.tenant, operation, input.key, requestJson, result);
      return {...result};
    });
  }

  pay(actor, input) {
    return this.#transition(actor, input, 'pay', 'open', 'paid');
  }

  refund(actor, input) {
    return this.#transition(actor, input, 'refund', 'paid', 'refunded');
  }

  get(actor, id) {
    validateActor(actor);
    if (!nonemptyString(id)) fail('VALIDATION');
    const row = this.#database.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (!row) fail('NOT_FOUND');
    return publicInvoice(row);
  }

  list(actor, input) {
    validateActor(actor);
    if (!hasExactOwnKeys(input, ['page', 'pageSize']) ||
        !safeInteger(input.page, 1) || !safeInteger(input.pageSize, 1) ||
        input.pageSize > 50) fail('VALIDATION');

    const total = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?
    `).get(actor.tenant).total;
    const offset = (input.page - 1) * input.pageSize;
    const rows = Number.isSafeInteger(offset) ? this.#database.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ?
      ORDER BY creation_order LIMIT ? OFFSET ?
    `).all(actor.tenant, input.pageSize, offset) : [];
    return {items: rows.map(publicInvoice), total};
  }

  close() {
    this.#database.close();
  }
}
