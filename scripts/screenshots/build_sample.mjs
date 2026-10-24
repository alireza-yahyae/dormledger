// Builds sample-state.json: the JSON the Mini App would get from /api/state, for a made-up room.
// Balances and the settlement plan come from the REAL domain code (src/domain), so the screenshots show real behaviour.
// No real people or amounts: every name and number below is invented.
//
//   node --experimental-strip-types --no-warnings scripts/screenshots/build_sample.mjs
import { writeFileSync } from 'node:fs';
import { computeBalances } from '../../src/domain/ledger.ts';
import { proposeTransfers, roundBalances } from '../../src/domain/settlement.ts';
import { equalAllocation, customAllocation } from '../../src/domain/allocation.ts';

const T = 100; // amounts are stored in hundredths of a toman
const members = [
  { id: 'm-ali', name: 'علی', nick: 'ابوعلی', role: 'owner', active: true, linked: true, sub: false },
  { id: 'm-reza', name: 'رضا', nick: '', role: 'admin', active: true, linked: true, sub: false },
  { id: 'm-amir', name: 'امیر', nick: '', role: 'member', active: true, linked: true, sub: false },
  { id: 'm-sina', name: 'سینا', nick: '', role: 'member', active: true, linked: true, sub: false },
  { id: 'm-nima', name: 'نیما', nick: '', role: 'member', active: true, linked: true, sub: true }, // guest member
  { id: 'm-sara', name: 'سارا', nick: '', role: 'member', active: true, linked: false, sub: true }, // guest member, not on Telegram yet
];
const [ali, reza, amir, sina, nima] = members.map((m) => m.id);

// [date, description, category, total (toman), payer, split]  — a guest is only in an expense when ticked, or when they paid
const raw = [
  ['2026-10-22', 'پیتزا شب جمعه', 'غذا', 480000, reza, [ali, reza, amir, sina]],
  ['2026-10-20', 'قبض برق', 'قبوض', 360000, ali, [ali, reza, amir, sina]],
  ['2026-10-18', 'نان، پنیر و لبنیات', 'غذا', 184000, amir, [ali, reza, amir, sina]],
  ['2026-10-15', 'سینما', 'تفریح', 600000, nima, [ali, reza, amir, nima]], // the guest paid, so the guest is ticked
  ['2026-10-10', 'اینترنت ماهانه', 'قبوض', 440000, reza, [ali, reza, amir, sina]],
  ['2026-10-07', 'خرید خانه', 'خرید خانه', 270000, sina, { [ali]: 90000, [amir]: 120000, [sina]: 60000 }],
];
const expenses = raw.map(([date, desc, category, toman, payer, split], i) => {
  const total = toman * T;
  const r = Array.isArray(split) ? equalAllocation(total, split) : customAllocation(total, Object.entries(split).map(([memberId, v]) => ({ memberId, amount: v * T })));
  if (!r.ok) throw new Error(desc + ': ' + r.error);
  return { id: 'e' + (i + 1), desc, total, payer, method: Array.isArray(split) ? 'equal' : 'custom', date, category, notes: null, status: 'active', version: 1, by: payer, reason: null, allocs: r.allocations.map((a) => ({ m: a.memberId, a: a.amount })) };
});

const settlements = [{ id: 's1', from: amir, to: reza, amount: 50000 * T, date: '2026-10-12' }];
const pending = [{ id: 's2', from: sina, to: reza, amount: 40000 * T, date: '2026-10-23' }];

const net = computeBalances(members.map((m) => m.id),
  expenses.map((e) => ({ id: e.id, total: e.total, payerId: e.payer, allocations: e.allocs.map((a) => ({ memberId: a.m, amount: a.a })), status: 'active' })),
  settlements.map((s) => ({ id: s.id, fromId: s.from, toId: s.to, amount: s.amount, status: 'confirmed' })));
const ROUND = 1000; // the room rounds suggested payments to 1000 toman
const plan = proposeTransfers(roundBalances(net, ROUND * T)).map((p) => ({ from: p.fromId, to: p.toId, amount: p.amount }));

const totals = { total: 0, paid: {}, share: {}, category: {} };
for (const e of expenses) {
  totals.total += e.total; totals.paid[e.payer] = (totals.paid[e.payer] ?? 0) + e.total;
  for (const a of e.allocs) totals.share[a.m] = (totals.share[a.m] ?? 0) + a.a;
  totals.category[e.category] = (totals.category[e.category] ?? 0) + e.total;
}
const octTotal = totals.total;
const state = {
  me: { id: ali, name: 'علی', nick: 'ابوعلی', role: 'owner', admin: true },
  dorm: { id: 'r-214', name: 'اتاق ۲۱۴', requireConfirm: true, roundTo: ROUND },
  members, balances: Object.fromEntries(net), plan,
  rooms: [{ id: 'r-214', name: 'اتاق ۲۱۴', role: 'owner', current: true }, { id: 'r-north', name: 'خانه‌ی شمال', role: 'member', current: false }],
  pending, expenses: expenses.slice().reverse(), settlements, archives: [], totals,
  categories: ['غذا', 'قبوض', 'خرید خانه', 'حمل‌ونقل', 'تفریح', 'سایر'], today: '2026-10-23',
  monthly: { '2026-05': { total: 910000 * T, count: 7 }, '2026-06': { total: 1120000 * T, count: 9 }, '2026-07': { total: 1380000 * T, count: 11 }, '2026-08': { total: 1260000 * T, count: 10 }, '2026-09': { total: 1590000 * T, count: 12 }, '2026-10': { total: octTotal, count: expenses.length } },
};
writeFileSync(new URL('./sample-state.json', import.meta.url), JSON.stringify(state, null, 1) + '\n');
console.log('balances (toman):', Object.fromEntries([...net].map(([k, v]) => [members.find((m) => m.id === k).name, v / T])));
console.log('plan:', plan.map((p) => `${members.find((m) => m.id === p.from).name} -> ${members.find((m) => m.id === p.to).name}: ${p.amount / T}`));
