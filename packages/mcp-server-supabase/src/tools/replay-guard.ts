/**
 * Single-use enforcement for accepted confirmations (supabase/mcp#318).
 *
 * `requestState` is HMAC-signed and stateless: valid until it expires, and
 * valid any number of times. Replaying one accepted `create_project` resume
 * created one billable project per replay. Each minted state now carries a
 * random `nonce`; the server consumes it once, right before the side effect.
 */
export type ConfirmationReplayGuard = {
  /**
   * Atomically records `nonce` as used. Resolves `true` on first use and
   * `false` on every later use. Must be atomic across every instance that can
   * resume the same state: with Redis, `SET key 1 NX PXAT <expiresAtMs>`.
   */
  consume(nonce: string, expiresAtMs: number): Promise<boolean>;
};

/**
 * In-process guard. Correct for stdio and single-instance HTTP. On a
 * multi-instance deployment it only stops replays that land on the same
 * instance, so hosted deployments must pass a shared guard instead.
 */
export function createMemoryReplayGuard(
  options: { maxEntries?: number; now?: () => number } = {}
): ConfirmationReplayGuard {
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const used = new Map<string, number>();

  function sweep() {
    const t = now();
    for (const [nonce, exp] of used) {
      if (exp <= t) {
        used.delete(nonce);
      }
    }
  }

  return {
    // No await before the check-and-set: atomic within one JS event loop.
    async consume(nonce, expiresAtMs) {
      if (used.has(nonce)) {
        return false;
      }
      if (used.size >= maxEntries) {
        sweep();
        if (used.size >= maxEntries) {
          // Fail closed: refusing a legitimate confirmation (the user is asked
          // again) is cheaper than letting an unbounded replay through.
          return false;
        }
      }
      used.set(nonce, expiresAtMs);
      return true;
    },
  };
}

/**
 * Process-wide default. The hosted server builds a server per request, so a
 * guard created per server instance would never see a second use.
 */
export const defaultReplayGuard = createMemoryReplayGuard();
