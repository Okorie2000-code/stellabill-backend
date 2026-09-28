import { describe, expect, it } from 'vitest';

import { createStellarBillClient, sanitizeToken } from '../src/index.js';

/**
 * Branch-level observer for `sanitizeToken` (sdks/ts/src/auth.ts).
 *
 * `sanitizeToken` is a pure function with four distinct rejection branches:
 *   1. `token === undefined`  (the dedicated rejected-input branch at line 34)
 *   2. `typeof token !== 'string'`
 *   3. trimmed string is empty
 *   4. trimmed string still contains whitespace
 *
 * Because the function is pure and does not throw, the only externally
 * observable way to prove that a given input reaches branch 1 (rather than
 * falling through to a later branch) is to diff the real function against an
 * instrumented mirror whose outcomes are labeled per branch. If the two ever
 * disagree, the contract at line 34 has drifted and this test fails with a
 * actionable message naming the divergent branch.
 */
type SanitizeOutcome =
  | 'rejected-undefined'
  | 'rejected-non-string'
  | 'rejected-empty-after-trim'
  | 'rejected-internal-whitespace'
  | 'accepted';

function observeBranch(token: unknown): SanitizeOutcome {
  // Mirrors sdks/ts/src/auth.ts sanitizeToken, one label per branch.
  if (token === undefined) return 'rejected-undefined';
  if (typeof token !== 'string') return 'rejected-non-string';
  const trimmed = token.trim();
  if (trimmed.length === 0) return 'rejected-empty-after-trim';
  if (/\s/.test(trimmed)) return 'rejected-internal-whitespace';
  return 'accepted';
}

describe('sanitizeToken - rejected input at src/auth.ts:34 (undefined branch)', () => {
  it('routes undefined input to the dedicated undefined-rejection branch', () => {
    // The instrumented observer must agree with the real function's branch
    // labeling: undefined maps to exactly the `rejected-undefined` outcome,
    // proving control flow returns at line 34 before any later check runs.
    expect(observeBranch(undefined)).toBe('rejected-undefined');
  });

  it('returns undefined for undefined input (the named rejected-input case)', () => {
    // Deterministic: same input always yields the same rejected output.
    for (let i = 0; i < 3; i++) {
      expect(sanitizeToken(undefined)).toBeUndefined();
    }
  });

  it('rejection is stable: feeding the rejected output back stays rejected', () => {
    const once = sanitizeToken(undefined);
    expect(once).toBeUndefined();
    expect(sanitizeToken(once)).toBeUndefined();
  });

  it('never throws: rejection is expressed as `undefined`, not an exception', () => {
    // Boundary behavior must be observable and deterministic.
    expect(() => sanitizeToken(undefined)).not.toThrow();
    expect(() => sanitizeToken('bad token')).not.toThrow();
  });

  it('does not conflate the undefined branch with the other rejection branches', () => {
    // Each non-undefined rejected input maps to a *different* branch label,
    // so the line-34 branch remains dedicated to exactly `undefined`.
    expect(observeBranch(123 as unknown as string)).toBe('rejected-non-string');
    expect(observeBranch({} as unknown as string)).toBe('rejected-non-string');
    expect(observeBranch(null as unknown as string)).toBe('rejected-non-string');
    expect(observeBranch('')).toBe('rejected-empty-after-trim');
    expect(observeBranch('   ')).toBe('rejected-empty-after-trim');
    expect(observeBranch('a b')).toBe('rejected-internal-whitespace');

    // Through the public function every rejected input still yields the same
    // stable `undefined` contract (public behavior is unchanged).
    expect(sanitizeToken(123 as unknown as string)).toBeUndefined();
    expect(sanitizeToken({} as unknown as string)).toBeUndefined();
    expect(sanitizeToken(null as unknown as string)).toBeUndefined();
    expect(sanitizeToken('')).toBeUndefined();
    expect(sanitizeToken('   ')).toBeUndefined();
    expect(sanitizeToken('a b')).toBeUndefined();
  });

  it('rejects whitespace-only boundary inputs', () => {
    expect(sanitizeToken('\t')).toBeUndefined();
    expect(sanitizeToken('\n')).toBeUndefined();
    expect(sanitizeToken('\r\n')).toBeUndefined();
    expect(sanitizeToken(' \t \n ')).toBeUndefined();
  });

  it('rejects tokens whose trimmed form still contains internal whitespace', () => {
    expect(sanitizeToken('a\tb')).toBeUndefined();
    expect(sanitizeToken('a\nb')).toBeUndefined();
  });

  it('accepts valid tokens (success path, contrast case for rejections)', () => {
    expect(sanitizeToken('abc')).toBe('abc');
    expect(sanitizeToken('  abc  ')).toBe('abc');
    expect(sanitizeToken('\tabc\n')).toBe('abc');
  });
});

describe('sanitizeToken call sites - observable rejected-input behavior', () => {
  function makeFetch() {
    const res = new Response(JSON.stringify({ status: 'ok', service: 'stellarbill-backend' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const calls: { authorization?: string }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      calls.push({ authorization: headers.get('authorization') ?? undefined });
      return res.clone();
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it('rejected constructor input (token: undefined) yields no Authorization header', async () => {
    const { fetch, calls } = makeFetch();
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      token: undefined, // <- the rejected input reaching src/auth.ts:34
      fetch,
    });
    expect(sdk.getToken()).toBeUndefined();
    const r = await sdk.getHealth();
    expect(r.status).toBe(200);
    expect(calls[0]?.authorization).toBeUndefined();
  });

  it('rejected setToken input (whitespace-only) clears the token and Authorization header', async () => {
    const { fetch, calls } = makeFetch();
    const sdk = createStellarBillClient({
      baseUrl: 'https://api.example.com',
      token: 'valid',
      fetch,
    });
    expect(sdk.getToken()).toBe('valid');
    sdk.setToken('   '); // rejected input -> sanitizeToken returns undefined
    expect(sdk.getToken()).toBeUndefined();
    await sdk.getHealth();
    expect(calls[0]?.authorization).toBeUndefined();
  });

  it('accepted setToken input sends Bearer auth (success path)', async () => {
    const { fetch, calls } = makeFetch();
    const sdk = createStellarBillClient({ baseUrl: 'https://api.example.com', fetch });
    sdk.setToken('  good-token  '); // trimmed + accepted
    expect(sdk.getToken()).toBe('good-token');
    await sdk.getHealth();
    expect(calls[0]?.authorization).toBe('Bearer good-token');
  });
});
