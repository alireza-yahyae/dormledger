import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatToman } from '../../src/domain/money.ts';
import { equalAllocation, customAllocation } from '../../src/domain/allocation.ts';
import { computeBalances } from '../../src/domain/ledger.ts';
import type { LedgerExpense, LedgerSettlement } from '../../src/domain/ledger.ts';
import { proposeTransfers } from '../../src/domain/settlement.ts';

const bal = (m: Map<string, number>) => Object.fromEntries(m);
const E = (id: string, total: number, payerId: string, allocations: { memberId: string; amount: number }[], status: 'active' | 'cancelled' = 'active'): LedgerExpense => ({ id, total, payerId, allocations, status });

test('amount parsing: Persian/Arabic digits and separators', () => {
  for (const s of ['۵۰۰۰۰', '50,000', '۵۰٬۰۰۰', '50000', '٥٠٠٠٠', ' 50 000 ']) assert.deepEqual(parseAmount(s), { ok: true, value: 5000000 });
});
test('amount parsing rejects bad input', () => {
  for (const s of ['', '0', '-5', '12.345', 'abc', '1e5', '۰', '99999999999999999999']) assert.equal(parseAmount(s).ok, false, s);
});
test('equal: payer is participant (4 people)', () => {
  const r = equalAllocation(50000, ['ali', 'reza', 'amir', 'mehdi']);
  assert.ok(r.ok && r.allocations.every((a) => a.amount === 12500));
  if (!r.ok) return;
  const net = computeBalances(['ali', 'reza', 'amir', 'mehdi'], [E('e', 50000, 'ali', r.allocations)]);
  assert.deepEqual(bal(net), { ali: 37500, reza: -12500, amir: -12500, mehdi: -12500 });
});
test('equal: payer excluded', () => {
  const r = equalAllocation(50000, ['reza', 'amir']);
  if (!r.ok) throw new Error('x');
  const net = computeBalances(['ali', 'reza', 'amir'], [E('e', 50000, 'ali', r.allocations)]);
  assert.deepEqual(bal(net), { ali: 50000, reza: -25000, amir: -25000 });
});
test('equal: uneven division is deterministic and exact', () => {
  const r = equalAllocation(100000, ['c', 'a', 'b']);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.allocations, [{ memberId: 'a', amount: 33334 }, { memberId: 'b', amount: 33333 }, { memberId: 'c', amount: 33333 }]);
});
test('equal: invalid inputs', () => {
  assert.equal(equalAllocation(0, ['a']).ok, false);
  assert.equal(equalAllocation(-1, ['a']).ok, false);
  assert.equal(equalAllocation(100, []).ok, false);
  assert.equal(equalAllocation(100, ['a', 'a']).ok, false);
  assert.equal(equalAllocation(2, ['a', 'b', 'c']).ok, false);
});
test('custom: exact, under, over, duplicates, zero', () => {
  assert.equal(customAllocation(50000, [{ memberId: 'reza', amount: 30000 }, { memberId: 'ali', amount: 20000 }]).ok, true);
  const under = customAllocation(50000, [{ memberId: 'a', amount: 1000 }]);
  assert.ok(!under.ok && under.remaining === 49000);
  const over = customAllocation(100, [{ memberId: 'a', amount: 200 }]);
  assert.ok(!over.ok && over.remaining === -100);
  assert.equal(customAllocation(100, [{ memberId: 'a', amount: 50 }, { memberId: 'a', amount: 50 }]).ok, false);
  assert.equal(customAllocation(100, [{ memberId: 'a', amount: 0 }, { memberId: 'b', amount: 100 }]).ok, false);
});
test('custom example: Reza 30000, Ali 20000, Ali paid', () => {
  const net = computeBalances(['ali', 'reza'], [E('e', 50000, 'ali', [{ memberId: 'reza', amount: 30000 }, { memberId: 'ali', amount: 20000 }])]);
  assert.deepEqual(bal(net), { ali: 30000, reza: -30000 });
  assert.deepEqual(proposeTransfers(net), [{ fromId: 'reza', toId: 'ali', amount: 30000 }]);
});
test('cancelled expenses ignored; corrupt allocations throw', () => {
  assert.deepEqual(bal(computeBalances(['a', 'b'], [E('x', 100, 'a', [{ memberId: 'b', amount: 100 }], 'cancelled')])), { a: 0, b: 0 });
  assert.throws(() => computeBalances(['a', 'b'], [E('y', 100, 'a', [{ memberId: 'b', amount: 99 }])]));
});
test('settlement: confirmed zeroes balances; pending does not', () => {
  const ex = [E('e', 100, 'a', [{ memberId: 'b', amount: 100 }])];
  const s: LedgerSettlement = { id: 's1', fromId: 'b', toId: 'a', amount: 100, status: 'confirmed' };
  assert.deepEqual(bal(computeBalances(['a', 'b'], ex, [s])), { a: 0, b: 0 });
  assert.deepEqual(bal(computeBalances(['a', 'b'], ex, [{ ...s, status: 'pending' }])), { a: 100, b: -100 });
});
test('large valid amount stays exact', () => {
  const r = equalAllocation(1_000_000_000_000, ['a', 'b', 'c']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.allocations.reduce((a, x) => a + x.amount, 0), 1_000_000_000_000);
});
test('property: 500 random ledgers keep all invariants', () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return Math.floor(seed / 65536) % n; };
  let checked = 0;
  for (let iter = 0; iter < 500; iter++) {
    const members = Array.from({ length: 2 + rnd(7) }, (_, i) => 'm' + i);
    const expenses: LedgerExpense[] = [];
    for (let k = 0; k < 1 + rnd(15); k++) {
      const parts = members.filter(() => rnd(2) === 1);
      if (!parts.length) parts.push(members[0]);
      const total = parts.length + rnd(2_000_000);
      let allocations;
      if (rnd(2)) { const r = equalAllocation(total, parts); if (!r.ok) continue; allocations = r.allocations; }
      else {
        let left = total;
        allocations = parts.map((p, i) => { const reserve = parts.length - i - 1; const a = reserve === 0 ? left : 1 + rnd(left - reserve); left -= a; return { memberId: p, amount: a }; });
      }
      assert.equal(allocations.reduce((a, x) => a + x.amount, 0), total);
      expenses.push(E('e' + k, total, members[rnd(members.length)], allocations));
    }
    const net = computeBalances(members, expenses);
    assert.equal([...net.values()].reduce((a, b) => a + b, 0), 0);
    const plan = proposeTransfers(net);
    const pos = [...net.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0);
    assert.equal(plan.reduce((a, t) => a + t.amount, 0), pos);
    assert.ok(plan.every((t) => t.amount > 0 && t.fromId !== t.toId));
    const after = computeBalances(members, expenses, plan.map((t, i) => ({ id: 's' + i, ...t, status: 'confirmed' as const })));
    assert.ok([...after.values()].every((v) => v === 0));
    assert.ok(plan.length <= members.length - 1);
    checked++;
  }
  assert.equal(checked, 500);
});

test('decimals: up to 2 places, stored in hundredths of a toman', () => {
  assert.deepEqual(parseAmount('33.33'), { ok: true, value: 3333 });
  assert.deepEqual(parseAmount('۳۳٫۵'), { ok: true, value: 3350 });
  assert.equal(parseAmount('1.005').ok, false);
  const total = (parseAmount('100') as any).value; // 100 toman = 10000
  const r = equalAllocation(total, ['a', 'b', 'c']);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.allocations.map((a) => a.amount), [3334, 3333, 3333]);
    assert.equal(r.allocations.reduce((n, a) => n + a.amount, 0), total);
  }
  assert.ok(formatToman(3333).includes('۳۳٫۳۳'));
  assert.ok(!formatToman(5000000).includes('٫'));
});

// ---- C1: fewest payments ----
import { roundBalances } from '../../src/domain/settlement.ts';
const applyTransfers = (b: Map<string, number>, ts: { fromId: string; toId: string; amount: number }[]) => {
  const n = new Map(b);
  for (const t of ts) { n.set(t.fromId, (n.get(t.fromId) ?? 0) + t.amount); n.set(t.toId, (n.get(t.toId) ?? 0) - t.amount); }
  return n;
};
/** Independent reference: max number of disjoint zero-sum groups by plain recursion. Fewest payments = people - groups. */
const maxGroups = (v: number[]): number => {
  if (!v.length) return 0;
  const [first, ...rest] = v; let best = -Infinity;
  for (let m = 0; m < 1 << rest.length; m++) {
    let sum = first; const left: number[] = [];
    rest.forEach((x, i) => { if ((m >> i) & 1) sum += x; else left.push(x); });
    if (sum === 0) best = Math.max(best, 1 + maxGroups(left));
  }
  return best;
};

test('C1: independent groups are settled separately (greedy would need 4 payments, 3 is enough)', () => {
  const b = new Map([['a', 5], ['b', 4], ['e', -3], ['f', -2], ['g', -4]]);
  const t = proposeTransfers(b);
  assert.equal(t.length, 3);
  assert.deepEqual(t, [{ fromId: 'e', toId: 'a', amount: 3 }, { fromId: 'f', toId: 'a', amount: 2 }, { fromId: 'g', toId: 'b', amount: 4 }]);
  assert.ok([...applyTransfers(b, t).values()].every((x) => x === 0));
});

test('C1: edge cases and determinism', () => {
  assert.deepEqual(proposeTransfers(new Map()), []);
  assert.deepEqual(proposeTransfers(new Map([['a', 0], ['b', 0]])), []);
  assert.deepEqual(proposeTransfers(new Map([['b', -7], ['a', 7]])), [{ fromId: 'b', toId: 'a', amount: 7 }]);
  assert.throws(() => proposeTransfers(new Map([['a', 1]])), /sum to zero/);
  const m = new Map([['x', 3], ['y', -3], ['z', 0], ['w', 8], ['v', -8]]);
  assert.deepEqual(proposeTransfers(m), proposeTransfers(new Map([...m].reverse())), 'input order does not matter');
});

test('C1: property — always settles everything with the provably fewest payments (400 random cases)', () => {
  let seed = 7; const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
  for (let k = 0; k < 400; k++) {
    const n = 2 + rnd(7), b = new Map<string, number>(); let sum = 0;
    for (let i = 0; i < n - 1; i++) { const v = rnd(11) - 5; b.set('m' + i, v); sum += v; }
    b.set('m' + (n - 1), -sum);
    const t = proposeTransfers(b), nz = [...b.values()].filter((x) => x !== 0);
    assert.ok([...applyTransfers(b, t).values()].every((x) => x === 0), 'every balance ends at zero');
    assert.ok(t.every((x) => x.amount > 0 && x.fromId !== x.toId));
    assert.equal(t.length, nz.length ? nz.length - maxGroups(nz) : 0, JSON.stringify([...b]));
  }
});

test('C1: more than 14 non-zero balances falls back to greedy and still settles', () => {
  const b = new Map<string, number>(); let sum = 0;
  for (let i = 0; i < 19; i++) { const v = (i % 2 ? 1 : -1) * (i + 1) * 13; b.set('p' + String(i).padStart(2, '0'), v); sum += v; }
  b.set('zz', -sum);
  assert.ok([...applyTransfers(b, proposeTransfers(b)).values()].every((x) => x === 0));
});

// ---- C5: rounding ----
test('C5: rounding keeps the total at zero, stays within one unit, and results are multiples of the unit', () => {
  const r = roundBalances(new Map([['a', 140000], ['b', -60000], ['c', -80000]]), 100000);
  assert.deepEqual([...r].sort(), [['a', 200000], ['b', -100000], ['c', -100000]]);
  assert.deepEqual([...roundBalances(new Map([['a', 5], ['b', -5]]), 0)], [['a', 5], ['b', -5]], 'unit 0 = exact');
  let seed = 11; const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
  for (let k = 0; k < 300; k++) {
    const n = 2 + rnd(8), b = new Map<string, number>(); let sum = 0;
    for (let i = 0; i < n - 1; i++) { const v = rnd(900001) - 450000; b.set('m' + i, v); sum += v; }
    b.set('m' + (n - 1), -sum);
    const r2 = roundBalances(b, 100000);
    assert.equal([...r2.values()].reduce((a, x) => a + x, 0), 0, 'total stays zero');
    // (note: -100000 % 100000 is -0 in JS, so this is `=== 0`, not strictEqual)
    for (const [id, v] of r2) { assert.ok(v % 100000 === 0, 'multiple of the unit'); assert.ok(Math.abs(v - b.get(id)!) < 100000, 'within one unit'); }
  }
});
