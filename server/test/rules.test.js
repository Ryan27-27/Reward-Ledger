import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReward, tierFor, tierProgress, TIERS } from '../src/services/rules.js';

test('bronze shopping: 8 pts per ₹100', () => {
  const r = computeReward({ category: 'SHOPPING', amountPaise: 1_000_000, lifetimeSpendPaise: 0, isFirstPayment: false });
  assert.equal(r.points, 800);
  assert.equal(r.tier, 'BRONZE');
});
test('tier multipliers apply to base', () => {
  const at = (spend) => computeReward({ category: 'SHOPPING', amountPaise: 1_000_000, lifetimeSpendPaise: spend, isFirstPayment: false }).points;
  assert.equal(at(1_000_000), 1000);   // silver 1.25×
  assert.equal(at(5_000_000), 1200);   // gold 1.5×
  assert.equal(at(20_000_000), 1600);  // platinum 2×
});
test('floors fractional points, never rounds up', () => {
  assert.equal(computeReward({ category: 'RENT', amountPaise: 9_999, lifetimeSpendPaise: 0, isFirstPayment: false }).points, 2); // 99.99/100*3 = 2.99
});
test('cap at 10,000 per payment, bonus added after the cap', () => {
  const r = computeReward({ category: 'SHOPPING', amountPaise: 50_000_000, lifetimeSpendPaise: 0, isFirstPayment: true });
  assert.equal(r.base, 10_000);
  assert.equal(r.points, 10_050);
  assert.match(r.explanation, /capped/);
});
test('tier boundaries are inclusive and progress is sane', () => {
  assert.equal(tierFor(999_999).name, 'BRONZE');
  assert.equal(tierFor(1_000_000).name, 'SILVER');
  assert.equal(tierFor(TIERS[3].minSpendPaise * 10).name, 'PLATINUM');
  assert.deepEqual(tierProgress(500_000), { current: 'BRONZE', next: 'SILVER', remainingPaise: 500_000, pct: 50 });
  assert.equal(tierProgress(99_999_999).next, null);
});
