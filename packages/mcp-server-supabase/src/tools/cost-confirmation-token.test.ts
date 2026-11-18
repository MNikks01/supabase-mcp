import { describe, expect, test } from 'vitest';
import { createCostConfirmationTokens } from './cost-confirmation-token.js';
import { createMemoryReplayGuard } from './replay-guard.js';

const cost = { type: 'project', recurrence: 'monthly', amount: 10 };

describe('cost confirmation tokens', () => {
  test('round-trips for the same cost', async () => {
    const t = createCostConfirmationTokens({ key: 'k'.repeat(32) });
    expect(await t.verify(await t.mint(cost), cost)).toBe(true);
  });

  test('rejects another cost, another principal, another key', async () => {
    const a = createCostConfirmationTokens({
      key: 'k'.repeat(32),
      principal: 'u1',
    });
    const token = await a.mint(cost);
    expect(await a.verify(token, { ...cost, amount: 0 })).toBe(false);
    const otherUser = createCostConfirmationTokens({
      key: 'k'.repeat(32),
      principal: 'u2',
    });
    expect(await otherUser.verify(token, cost)).toBe(false);
    const otherKey = createCostConfirmationTokens({
      key: 'x'.repeat(32),
      principal: 'u1',
    });
    expect(await otherKey.verify(token, cost)).toBe(false);
  });

  test('rejects expired, tampered and malformed IDs', async () => {
    let now = 1_000;
    const t = createCostConfirmationTokens({
      key: 'k'.repeat(32),
      ttlSeconds: 60,
      now: () => now,
    });
    const token = await t.mint(cost);
    const [v, exp, mac] = token.split('.');
    expect(await t.verify(`${v}.${Number(exp) + 1}.${mac}`, cost)).toBe(false);
    expect(await t.verify('not-a-token', cost)).toBe(false);
    now += 61_000;
    expect(await t.verify(token, cost)).toBe(false);
  });
});

describe('memory replay guard', () => {
  test('first use wins, later uses lose, expired entries are reclaimed', async () => {
    let now = 0;
    const g = createMemoryReplayGuard({ maxEntries: 1, now: () => now });
    expect(await g.consume('a', 100)).toBe(true);
    expect(await g.consume('a', 100)).toBe(false);
    // Full and nothing expired: fail closed.
    expect(await g.consume('b', 100)).toBe(false);
    now = 200;
    expect(await g.consume('b', 300)).toBe(true);
  });
});
