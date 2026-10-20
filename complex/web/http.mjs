/** Shared HTTP contract helpers. Pure functions without Node imports so screens may also import them. */
export const SESSIONS = Object.freeze({
  'alpha-admin': Object.freeze({ tenant: 'alpha', role: 'admin' }),
  'alpha-reader': Object.freeze({ tenant: 'alpha', role: 'reader' }),
  'beta-admin': Object.freeze({ tenant: 'beta', role: 'admin' }),
});

export const STATUS = Object.freeze({ AUTH: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409, METHOD: 405, TOO_LARGE: 413, UNSUPPORTED: 415 });

export class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Resolve the dummy fixture session header to a fresh actor; never from body or query. */
export function actorForSession(value) {
  const actor = typeof value === 'string' && Object.hasOwn(SESSIONS, value) ? SESSIONS[value] : undefined;
  if (!actor) throw new HttpError('AUTH', 'Missing or unknown x-fixture-session; use alpha-admin, alpha-reader or beta-admin');
  return { tenant: actor.tenant, role: actor.role };
}

/** Body must be a plain JSON object with exactly the listed keys. */
export function requireBody(body, keys) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('VALIDATION', `Request body must be a JSON object with keys ${keys.join(', ')}`);
  const actual = Object.keys(body);
  const missing = keys.filter(k => !Object.hasOwn(body, k));
  const extra = actual.filter(k => !keys.includes(k));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected ${extra.join(', ')}`);
    throw new HttpError('VALIDATION', `Request body must have exactly ${keys.join(', ')} (${parts.join('; ')})`);
  }
  return body;
}

const POSITIVE = /^[1-9][0-9]{0,15}$/;

/** Parse ?page=&pageSize= strictly; other query keys or repeated keys are rejected. Defaults page 1, pageSize 2. */
export function parsePage(searchParams) {
  const result = { page: 1, pageSize: 2 };
  const seen = new Set();
  for (const [name, value] of searchParams) {
    if (name !== 'page' && name !== 'pageSize') throw new HttpError('VALIDATION', `Unknown query parameter ${name}; only page and pageSize are accepted`);
    if (seen.has(name)) throw new HttpError('VALIDATION', `Query parameter ${name} must appear once`);
    seen.add(name);
    const n = POSITIVE.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(n)) throw new HttpError('VALIDATION', `${name} must be a positive integer`);
    result[name] = n;
  }
  return result;
}

/** Reject any query string on routes that take none. */
export function requireNoQuery(searchParams) {
  for (const [name] of searchParams) throw new HttpError('VALIDATION', `Unknown query parameter ${name}`);
}

/** Map a thrown service or HTTP error to {status, body}. Unknown errors become 500 without internals. */
export function errorResponse(error) {
  const code = error && typeof error.code === 'string' && Object.hasOwn(STATUS, error.code) ? error.code : undefined;
  if (!code) return { status: 500, body: { code: 'INTERNAL', message: 'Internal server error; retry later or contact the operator' } };
  const message = typeof error.message === 'string' && error.message.trim() ? error.message : `Request failed with ${code}`;
  return { status: STATUS[code], body: { code, message } };
}

/**
 * Route definition shared by the vertical modules:
 *   { method: 'GET'|'POST', path: ['api','reservations',':id'], handle: ({actor, params, query, body}) => ({status, body}) }
 * `params` holds decoded `:name` segments, `query` is URLSearchParams, `body` is the parsed JSON (POST only).
 */
export function matchRoute(routes, method, segments) {
  let pathMatched = false;
  for (const route of routes) {
    if (route.path.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const part = route.path[i];
      if (part.startsWith(':')) {
        if (!segments[i]) { ok = false; break; }
        params[part.slice(1)] = segments[i];
      } else if (part !== segments[i]) { ok = false; break; }
    }
    if (!ok) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }
  return pathMatched ? { methodNotAllowed: true } : undefined;
}
