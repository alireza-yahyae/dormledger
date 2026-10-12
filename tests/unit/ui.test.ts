import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Boots the real Mini App script against a stubbed DOM and checks every view renders and the edit flow talks to the API.
const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
const js = html.match(/<script>\n?([\s\S]*?)<\/script>/)![1];

const state = {
  me: { id: 'a', name: 'علی', nick: '', role: 'owner', admin: true }, dorm: { id: 'd', name: 'خوابگاه', requireConfirm: true },
  members: [{ id: 'a', name: 'علی', nick: 'ابو', role: 'owner', active: true, linked: true }, { id: 'b', name: 'رضا', nick: '', role: 'member', active: true, linked: true }, { id: 'c', name: 'امیر', nick: '', role: 'member', active: true, linked: false }],
  balances: { a: -3333, b: 3333, c: 0 }, plan: [{ from: 'a', to: 'b', amount: 3333 }], rooms: [{ id: 'd', name: 'خوابگاه', role: 'owner', current: true }], pending: [], settlements: [],
  expenses: [
    { id: 'e1', desc: 'نان', total: 10000, payer: 'a', method: 'equal', date: '2026-10-09', category: 'غذا', notes: null, status: 'active', version: 3, by: 'a', reason: null, allocs: [{ m: 'a', a: 3334 }, { m: 'b', a: 3333 }, { m: 'c', a: 3333 }] },
    { id: 'e2', desc: 'قبض', total: 9000000, payer: 'b', method: 'custom', date: '2026-10-08', category: null, notes: 'x', status: 'cancelled', version: 2, by: 'b', reason: 'اشتباه', allocs: [{ m: 'a', a: 9000000 }] }],
  totals: { total: 10000, paid: { a: 10000 }, share: { a: 3334, b: 3333, c: 3333 }, category: { 'غذا': 10000 } }, categories: ['غذا', 'قبوض', 'سایر'], archives: [{ id: 'ar1', createdAt: '2026-10-10T10:00:00.000Z', expiresAt: new Date(Date.now() + 5 * 3600000).toISOString(), expenses: 2, settlements: 1 }], today: '2026-10-10', monthly: { '2026-10': { total: 10000, count: 1 } },
};

test('Mini App: every tab renders, expense detail + edit flow work', async () => {
  const els: Record<string, any> = {};
  const mkEl = (id: string): any => (els[id] ??= { id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, addEventListener() {}, closest() { return null; }, querySelector() { return mkEl('x'); }, querySelectorAll() { return []; }, focus() {}, scrollTop: 0 });
  const doc: any = { querySelector: (s: string) => mkEl(s), querySelectorAll: () => [], addEventListener: (e: string, f: any) => { if (e === 'DOMContentLoaded') doc._boot = f; }, documentElement: { setAttribute() {} }, body: mkEl('body'), createElement: () => mkEl('c') };
  const calls: { path: string; body: any }[] = [];
  const ctx: any = { console, document: doc, location: { hash: '' }, navigator: {}, crypto: { randomUUID: () => 'k'.repeat(10) }, Intl, Date, Number, Math, JSON, String, Array, Object, Promise, setTimeout, clearTimeout, URLSearchParams, confirm: () => true,
    fetch: async (path: string, init: any) => { calls.push({ path, body: init?.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => state }; } };
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.scrollTo = () => {};
  ctx.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {}, colorScheme: 'light', BackButton: { onClick() {}, show() {}, hide() {} } } };
  vm.createContext(ctx); vm.runInContext(js, ctx); doc._boot();
  await new Promise((r) => setTimeout(r, 30));
  const run = (code: string) => vm.runInContext(code, ctx);

  for (const t of ['home', 'exp', 'settle', 'members', 'more']) { run(`S.tab='${t}';render()`); assert.ok(els['#app'].innerHTML.length > 100, t + ' rendered'); }
  run(`S.tab='exp';S.q='نان';render()`); assert.match(els['#app'].innerHTML, /نان/);
  run(`S.q='چیزی-که-نیست';render()`); assert.match(els['#app'].innerHTML, /نتیجه‌ای پیدا نشد/);
  run(`S.q='';S.min='5';S.max='200';render()`); assert.match(els['#app'].innerHTML, /نان/, 'filters are in toman, totals in hundredths');

  run(`S.tab='more';render()`); assert.match(els['#app'].innerHTML, /data-a="togglerc"/, 'admin sees the confirmation option');
  assert.match(els['#app'].innerHTML, /data-a="clearhist"/); assert.match(els['#app'].innerHTML, /data-a="restorehist" data-id="ar1"/, 'restore offered for an archive');
  run(`A.clearhist({})`); assert.match(els['#layer'].innerHTML, /data-a="clearok"/);
  run(`A.restorehist({dataset:{id:'ar1'}})`); assert.match(els['#layer'].innerHTML, /data-a="restoreok"/);
  run(`closeLayer()`);
  run(`S.tab='exp';render()`);
  run(`A.exp({dataset:{id:'e1'}})`); assert.match(els['#layer'].innerHTML, /data-a="editexp"/, 'creator/admin sees the edit button');
  run(`A.exp({dataset:{id:'e2'}})`); assert.doesNotMatch(els['#layer'].innerHTML, /editexp/, 'cancelled expenses cannot be edited');
  run(`closeLayer(); A.exp({dataset:{id:'e1'}}); A.editexp({dataset:{id:'e1'}})`);
  assert.match(els['#layer'].innerHTML, /ویرایش هزینه/); assert.equal(run('F.amount'), '100'); assert.equal(run('F.editV'), 3);
  run(`F.amount='150.01'`); run(`A.freview({})`); assert.equal(run('F.step'), 'review');
  run(`A.fsubmit(document.querySelector('#okbtn'))`); await new Promise((r) => setTimeout(r, 30));
  const upd = calls.find((c) => c.path === '/api/expense/update');
  assert.ok(upd, 'edit posts to /api/expense/update');
  assert.equal(upd!.body.id, 'e1'); assert.equal(upd!.body.version, 3); assert.equal(upd!.body.amount, '15001'); assert.deepEqual(upd!.body.participants.sort(), ['a', 'b', 'c']);
});
