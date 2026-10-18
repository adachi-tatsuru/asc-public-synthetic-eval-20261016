import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const INVOICE_COLUMNS = `
  id,
  tenant,
  reservation_id AS reservationId,
  amount_cents AS amountCents,
  status,
  version
`;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')) return false;
  actual.sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSafeIntegerAtLeast(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateActor(actor) {
  if (
    !hasExactKeys(actor, ['tenant', 'role']) ||
    !isNonemptyString(actor.tenant) ||
    (actor.role !== 'admin' && actor.role !== 'reader')
  ) {
    throw failure('AUTH', 'Invalid actor');
  }
}

function requireAdmin(actor) {
  validateActor(actor);
  if (actor.role !== 'admin') throw failure('FORBIDDEN', 'Mutation requires an administrator');
}

function validatePage(query) {
  if (
    !hasExactKeys(query, ['page', 'pageSize']) ||
    !isSafeIntegerAtLeast(query.page, 1) ||
    !isSafeIntegerAtLeast(query.pageSize, 1) ||
    query.pageSize > 50
  ) {
    throw failure('VALIDATION', 'Invalid pagination');
  }
}

function validateId(id) {
  if (!isNonemptyString(id)) throw failure('VALIDATION', 'Invalid id');
}

function validateKey(key) {
  if (!isNonemptyString(key)) throw failure('VALIDATION', 'Invalid idempotency key');
}

function invoiceFromRow(row) {
  return {
    id: row.id,
    tenant: row.tenant,
    reservationId: row.reservationId,
    amountCents: row.amountCents,
    status: row.status,
    version: row.version,
  };
}

function parseReplay(row, canonicalInput) {
  if (row.input_json !== canonicalInput) {
    throw failure('CONFLICT', 'Idempotency key was already used for different input');
  }
  return JSON.parse(row.result_json);
}

export class BillingService {
  #database;

  constructor(filename) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS billing_invoices (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'refunded')),
        version INTEGER NOT NULL,
        UNIQUE (tenant, reservation_id)
      );

      CREATE TABLE IF NOT EXISTS billing_idempotency (
        tenant TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (tenant, operation, idempotency_key)
      );
    `);
  }

  #transaction(operation) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the operation's error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  #replay(tenant, operation, key, canonicalInput) {
    const row = this.#database.prepare(`
      SELECT input_json, result_json
      FROM billing_idempotency
      WHERE tenant = ? AND operation = ? AND idempotency_key = ?
    `).get(tenant, operation, key);
    return row === undefined ? undefined : parseReplay(row, canonicalInput);
  }

  #record(tenant, operation, key, canonicalInput, result) {
    this.#database.prepare(`
      INSERT INTO billing_idempotency
        (tenant, operation, idempotency_key, input_json, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenant, operation, key, canonicalInput, JSON.stringify(result));
  }

  issue(actor, input) {
    requireAdmin(actor);
    if (!hasExactKeys(input, ['key', 'event'])) {
      throw failure('VALIDATION', 'Invalid issue input');
    }
    validateKey(input.key);

    const event = input.event;
    if (
      !hasExactKeys(event, ['id', 'tenant', 'sku', 'quantity', 'amountCents', 'currency', 'status', 'version']) ||
      !isNonemptyString(event.id) ||
      !isNonemptyString(event.tenant) ||
      !isNonemptyString(event.sku) ||
      !isSafeIntegerAtLeast(event.quantity, 1) ||
      !isSafeIntegerAtLeast(event.amountCents, 0) ||
      event.currency !== 'JPY' ||
      event.status !== 'reserved' ||
      !isSafeIntegerAtLeast(event.version, 1)
    ) {
      throw failure('VALIDATION', 'Invalid reservation event');
    }
    if (event.tenant !== actor.tenant) {
      throw failure('FORBIDDEN', 'Reservation event belongs to another tenant');
    }

    const canonicalInput = JSON.stringify({
      event: {
        id: event.id,
        tenant: event.tenant,
        sku: event.sku,
        quantity: event.quantity,
        amountCents: event.amountCents,
        status: event.status,
        version: event.version,
      },
    });

    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, 'issue', input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const duplicate = this.#database.prepare(`
        SELECT 1
        FROM billing_invoices
        WHERE tenant = ? AND reservation_id = ?
      `).get(actor.tenant, event.id);
      if (duplicate !== undefined) {
        throw failure('CONFLICT', 'An invoice already exists for this reservation');
      }

      const result = {
        id: randomUUID(),
        tenant: actor.tenant,
        reservationId: event.id,
        amountCents: event.amountCents,
        status: 'open',
        version: 1,
      };
      this.#database.prepare(`
        INSERT INTO billing_invoices
          (id, tenant, reservation_id, amount_cents, status, version)
        VALUES (?, ?, ?, ?, 'open', 1)
      `).run(result.id, result.tenant, result.reservationId, result.amountCents);
      this.#record(actor.tenant, 'issue', input.key, canonicalInput, result);
      return result;
    });
  }

  #transition(actor, input, operation, fromStatus, toStatus) {
    requireAdmin(actor);
    if (!hasExactKeys(input, ['key', 'id', 'expectedVersion'])) {
      throw failure('VALIDATION', `Invalid ${operation} input`);
    }
    validateKey(input.key);
    validateId(input.id);
    if (!isSafeIntegerAtLeast(input.expectedVersion, 1)) {
      throw failure('VALIDATION', 'Invalid expected version');
    }

    const canonicalInput = JSON.stringify({id: input.id, expectedVersion: input.expectedVersion});
    return this.#transaction(() => {
      const replay = this.#replay(actor.tenant, operation, input.key, canonicalInput);
      if (replay !== undefined) return replay;

      const row = this.#database.prepare(`
        SELECT ${INVOICE_COLUMNS}
        FROM billing_invoices
        WHERE tenant = ? AND id = ?
      `).get(actor.tenant, input.id);
      if (row === undefined) throw failure('NOT_FOUND', 'Invoice not found');
      if (row.version !== input.expectedVersion || row.status !== fromStatus) {
        throw failure('CONFLICT', `Invoice cannot be ${operation}ed`);
      }

      const nextVersion = row.version + 1;
      if (!Number.isSafeInteger(nextVersion)) {
        throw failure('VALIDATION', 'Invoice version exceeds the safe integer range');
      }
      this.#database.prepare(`
        UPDATE billing_invoices
        SET status = ?, version = ?
        WHERE tenant = ? AND id = ?
      `).run(toStatus, nextVersion, actor.tenant, input.id);

      const result = invoiceFromRow({...row, status: toStatus, version: nextVersion});
      this.#record(actor.tenant, operation, input.key, canonicalInput, result);
      return result;
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
    validateId(id);
    const row = this.#database.prepare(`
      SELECT ${INVOICE_COLUMNS}
      FROM billing_invoices
      WHERE tenant = ? AND id = ?
    `).get(actor.tenant, id);
    if (row === undefined) throw failure('NOT_FOUND', 'Invoice not found');
    return invoiceFromRow(row);
  }

  list(actor, query) {
    validateActor(actor);
    validatePage(query);
    const {total} = this.#database.prepare(`
      SELECT COUNT(*) AS total
      FROM billing_invoices
      WHERE tenant = ?
    `).get(actor.tenant);
    if (total === 0 || query.page > Math.floor((total - 1) / query.pageSize) + 1) {
      return {items: [], total};
    }

    const offset = (query.page - 1) * query.pageSize;
    const rows = this.#database.prepare(`
      SELECT ${INVOICE_COLUMNS}
      FROM billing_invoices
      WHERE tenant = ?
      ORDER BY sequence ASC
      LIMIT ? OFFSET ?
    `).all(actor.tenant, query.pageSize, offset);
    return {items: rows.map(invoiceFromRow), total};
  }

  close() {
    this.#database.close();
  }
}
