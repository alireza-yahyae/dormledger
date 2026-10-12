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
