/**
 * Legacy `confirm_cost` IDs (supabase/mcp#318).
 *
 * The ID used to be `sha256(cost)`. Cost values come from public pricing, so
 * an agent could compute a valid ID without ever calling `confirm_cost`. IDs
 * are now `v2.<expiry>.<HMAC>` under a server-held key, bound to the cost, the
 * principal (when known) and an expiry.
 *
 * Scope, stated plainly: legacy clients have no channel to a human, so an
 * agent can still call `confirm_cost` itself. This closes the precompute
 * bypass and makes every legacy confirmation go through `confirm_cost`, where
 * it can be logged; it does not create human consent. Form-capable clients
 * get that through elicitation instead.
 */
/** `confirm_cost` takes a loose shape; the ID binds whatever was confirmed. */
export type ConfirmedCost = {
  type: string;
  recurrence: string;
  amount: number;
};

export type CostConfirmationTokens = {
  mint(cost: ConfirmedCost): Promise<string>;
  verify(token: string, cost: ConfirmedCost): Promise<boolean>;
};

export type CostConfirmationTokenOptions = {
  /**
   * Root key. Pass the shared `requestState` key on multi-instance (hosted)
   * deployments so an ID minted on one instance verifies on another. Omitted,
   * a random key shared by every server in this process is used: right for
   * stdio and for per-request servers in one process, wrong across instances.
   */
  key?: string | Uint8Array;
  /** Bound into every ID when known, so one user's ID can't be used by another. */
  principal?: string;
  /** Defaults to 600. */
  ttlSeconds?: number;
  now?: () => number;
};

const VERSION = 'v2';
// Domain separation: never reuse the requestState key directly for this MAC.
const KEY_LABEL = 'supabase-mcp/legacy-cost-confirmation/v2';
const encoder = new TextEncoder();
// Process-wide, not per server: hosted HTTP builds a server per request, and
// `confirm_cost` and `create_project` arrive as separate requests.
const PROCESS_KEY = crypto.getRandomValues(new Uint8Array(32));

function toBytes(key: string | Uint8Array): Uint8Array {
  return typeof key === 'string' ? encoder.encode(key) : key;
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(raw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/** Canonical, order-independent encoding of the fields the ID binds. */
function payload(cost: ConfirmedCost, principal: string, exp: number): string {
  return JSON.stringify([
    VERSION,
    principal,
    exp,
    cost.type,
    cost.recurrence,
    cost.amount,
  ]);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function createCostConfirmationTokens(
  options: CostConfirmationTokenOptions = {}
): CostConfirmationTokens {
  const ttlMs = (options.ttlSeconds ?? 600) * 1000;
  const now = options.now ?? Date.now;
  const principal = options.principal ?? '';
  const root = options.key !== undefined ? toBytes(options.key) : PROCESS_KEY;

  const derived = (async () => {
    const rootKey = await hmacKey(root);
    const sub = await crypto.subtle.sign(
      'HMAC',
      rootKey,
      encoder.encode(KEY_LABEL)
    );
    return hmacKey(new Uint8Array(sub));
  })();

  async function mac(cost: ConfirmedCost, exp: number): Promise<string> {
    const key = await derived;
    const sig = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(payload(cost, principal, exp))
    );
    return base64url(sig);
  }

  return {
    async mint(cost) {
      const exp = now() + ttlMs;
      return `${VERSION}.${exp}.${await mac(cost, exp)}`;
    },
    async verify(token, cost) {
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== VERSION) {
        return false;
      }
      const exp = Number(parts[1]);
      if (!Number.isSafeInteger(exp) || exp < now()) {
        return false;
      }
      return constantTimeEqual(parts[2] ?? '', await mac(cost, exp));
    },
  };
}
