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
  if (!hasExactOwnKeys(actor, ['tenant', 'role'])) fail('AUTH');
  let tenant;
  let role;
  try {
    ({tenant, role} = actor);
  } catch {
    fail('AUTH');
  }
  if (!nonemptyString(tenant) || (role !== 'admin' && role !== 'reader')) fail('AUTH');
  return {tenant, role};
}

function authorizeMutation(actor) {
  const snapshot = validateActor(actor);
  if (snapshot.role !== 'admin') fail('FORBIDDEN');
  return snapshot.tenant;
}

function validateEvent(event) {
  const keys = ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'status', 'version'];
  if (!hasExactOwnKeys(event, keys)) fail('VALIDATION');
  let snapshot;
  try {
    snapshot = Object.fromEntries(keys.map(key => [key, event[key]]));
  } catch {
    fail('VALIDATION');
  }
  if (!nonemptyString(snapshot.id) ||
      !nonemptyString(snapshot.tenant) ||
      !nonemptyString(snapshot.sku) ||
      !safeInteger(snapshot.quantity, 1) ||
      !safeInteger(snapshot.amountCents, 0) ||
      snapshot.status !== 'reserved' ||
      !safeInteger(snapshot.version, 1)) fail('VALIDATION');
  return snapshot;
}

function validateIssueInput(input) {
  if (!hasExactOwnKeys(input, ['key', 'event'])) fail('VALIDATION');
  let key;
  let event;
  try {
    ({key, event} = input);
  } catch {
    fail('VALIDATION');
  }
  if (!nonemptyString(key)) fail('VALIDATION');
  return {key, event: validateEvent(event)};
}

function validateTransitionInput(input) {
  if (!hasExactOwnKeys(input, ['key', 'id', 'expectedVersion'])) fail('VALIDATION');
  let snapshot;
  try {
    snapshot = {
      key: input.key,
      id: input.id,
      expectedVersion: input.expectedVersion,
    };
  } catch {
    fail('VALIDATION');
  }
  if (!nonemptyString(snapshot.key) || !nonemptyString(snapshot.id) ||
      !safeInteger(snapshot.expectedVersion, 1)) fail('VALIDATION');
  return snapshot;
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
    const tenant = authorizeMutation(actor);
    const {key, event} = validateIssueInput(input);
    if (event.tenant !== tenant) fail('FORBIDDEN');
    const requestJson = JSON.stringify({key, event});

    return this.#transaction(() => {
      const replay = this.#replay(tenant, 'issue', key, requestJson);
      if (replay !== undefined) return replay;
      if (this.#database.prepare(`
        SELECT 1 FROM billing_invoices WHERE tenant = ? AND reservation_id = ?
      `).get(tenant, event.id)) fail('CONFLICT');

      const result = {
        id: randomUUID(), tenant, reservationId: event.id,
        amountCents: event.amountCents, status: 'open', version: 1,
      };
      this.#database.prepare(`
        INSERT INTO billing_invoices
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(result.id, result.tenant, result.reservationId, result.amountCents,
        result.status, result.version);
      this.#record(tenant, 'issue', key, requestJson, result);
      return {...result};
    });
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    const tenant = authorizeMutation(actor);
    const {key, id, expectedVersion} = validateTransitionInput(input);
    const requestJson = JSON.stringify({
      key, id, expectedVersion,
    });

    return this.#transaction(() => {
      const replay = this.#replay(tenant, operation, key, requestJson);
      if (replay !== undefined) return replay;
      const row = this.#database.prepare(`
        SELECT id, tenant, reservation_id, amount_cents, status, version
        FROM billing_invoices WHERE tenant = ? AND id = ?
      `).get(tenant, id);
      if (!row) fail('NOT_FOUND');
      if (row.version !== expectedVersion || row.status !== fromStatus) fail('CONFLICT');

      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) fail('VALIDATION');
      this.#database.prepare(`
        UPDATE billing_invoices SET status = ?, version = ?
        WHERE tenant = ? AND id = ?
      `).run(toStatus, nextVersion, tenant, id);
      const result = publicInvoice({...row, status: toStatus, version: nextVersion});
      this.#record(tenant, operation, key, requestJson, result);
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
    const {tenant} = validateActor(actor);
    if (!nonemptyString(id)) fail('VALIDATION');
    const row = this.#database.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ? AND id = ?
    `).get(tenant, id);
    if (!row) fail('NOT_FOUND');
    return publicInvoice(row);
  }

  list(actor, input) {
    const {tenant} = validateActor(actor);
    if (!hasExactOwnKeys(input, ['page', 'pageSize'])) fail('VALIDATION');
    let page;
    let pageSize;
    try {
      ({page, pageSize} = input);
    } catch {
      fail('VALIDATION');
    }
    if (!safeInteger(page, 1) || !safeInteger(pageSize, 1) || pageSize > 50) fail('VALIDATION');

    const total = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant = ?
    `).get(tenant).total;
    const offset = (page - 1) * pageSize;
    const rows = Number.isSafeInteger(offset) ? this.#database.prepare(`
      SELECT id, tenant, reservation_id, amount_cents, status, version
      FROM billing_invoices WHERE tenant = ?
      ORDER BY creation_order LIMIT ? OFFSET ?
    `).all(tenant, pageSize, offset) : [];
    return {items: rows.map(publicInvoice), total};
  }

  close() {
    this.#database.close();
  }
}
