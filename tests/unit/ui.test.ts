import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Boots the real Mini App script against a stubbed DOM and checks every view renders and the edit flow talks to the API.
const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
const js = html.match(/<script>\n?([\s\S]*?)<\/script>/)![1];

const state = {
  me: { id: 'a', name: 'علی', nick: '', role: 'owner', admin: true }, dorm: { id: 'd', name: 'خوابگاه', requireConfirm: true },
  members: [{ id: 'a', name: 'علی', nick: 'ابو', role: 'owner', active: true, linked: true }, { id: 'b', name: 'رضا', nick: '', role: 'member', active: true, linked: true }, { id: 'c', name: 'امیر', nick: '', role: 'member', active: true, linked: false, sub: true }],
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
  // C5 option + B14 leave button
  assert.match(els['#app'].innerHTML, /data-a="roundto"/, 'admin sees the rounding option');
  assert.doesNotMatch(els['#app'].innerHTML, /data-a="leave"/, 'the owner cannot leave');
  run(`A.roundto({})`); await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.find((c) => c.path === '/api/room/settings')!.body, { roundTo: 1000 }, 'toggling on asks for 1000 toman');
  run(`S.d.me.role='member';S.d.me.admin=false;render()`);
  assert.match(els['#app'].innerHTML, /data-a="leave"/, 'a member can leave');
  assert.doesNotMatch(els['#app'].innerHTML, /data-a="roundto"/, 'only admins change room settings');
  run(`A.leave({})`); assert.match(els['#layer'].innerHTML, /data-a="leaveok"/);
  run(`A.leaveok({})`); await new Promise((r) => setTimeout(r, 30));
  assert.ok(calls.some((c) => c.path === '/api/room/leave'), 'confirming posts to /api/room/leave');
  run(`closeLayer();S.d.me.role='owner';S.d.me.admin=true;S.d.dorm.roundTo=1000;S.tab='settle';render()`);
  assert.match(els['#app'].innerHTML, /گرد شده‌اند/, 'settle tab explains rounded amounts');
  run(`S.d.dorm.roundTo=0`);
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
  run(`closeLayer()`);

  // guest members (عضو مهمان): own section + toggle for admins (also on their own row), unticked by default in a new expense
  run(`S.d.me.role='owner';S.d.me.admin=true;S.tab='members';render()`);
  const html = () => els['#app'].innerHTML as string;
  assert.match(html(), /<h2>اعضای مهمان<\/h2>/, 'guests get their own box');
  assert.match(html(), /data-a="msub" data-id="c" aria-pressed="true"/);
  assert.match(html(), /data-a="msub" data-id="a" aria-pressed="false"/, 'the admin can also mark themself');
  assert.ok(html().indexOf('data-id="b"') < html().indexOf('<h2>اعضای مهمان'), 'main members are listed before the box');
  run(`A.msub({dataset:{id:'a'}})`); await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.filter((c) => c.path === '/api/member/substitute').pop()!.body, { id: 'a', substitute: true });
  run(`A.msub({dataset:{id:'c'}})`); await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.filter((c) => c.path === '/api/member/substitute').pop()!.body, { id: 'c', substitute: false });

  run(`A.add({})`);
  assert.equal(run('JSON.stringify(F.sel)'), '["a","b"]', 'main members ticked, the guest is not');
  const form = () => els['#layer'].innerHTML as string;
  assert.match(form(), /class="subbox"/); assert.match(form(), /class="subbox"[\s\S]*data-a="fpart" data-id="c" aria-pressed="false"/);
  assert.ok(form().indexOf('data-id="b" aria-pressed="true"') < form().indexOf('class="subbox"'), 'main chips come first');
  run(`A.fpart({dataset:{id:'c'}})`); assert.equal(run('JSON.stringify(F.sel)'), '["a","b","c"]', 'the author can tick a guest');
  run(`A.fdef({})`); assert.equal(run('JSON.stringify(F.sel)'), '["a","b"]', '«پیش‌فرض» restores the defaults');
  run(`A.fall({})`); assert.equal(run('JSON.stringify(F.sel)'), '["a","b","c"]');
  run(`A.fpart({dataset:{id:'a'}})`); assert.equal(run('JSON.stringify(F.sel)'), '["b","c"]', 'the author can untick a main member');
  run(`F.method='custom';showForm()`);
  assert.match(form(), /class="subbox"[\s\S]*class="ltr num sh" data-id="c"/, 'custom shares: guests in their own box too');
  run(`closeLayer()`);
  // a guest who PAYS is ticked; stops being ticked when someone else pays; editing never touches the saved selection
  run(`A.add({})`);
  run(`A.fpay({dataset:{id:'c'}})`); assert.equal(run('JSON.stringify(F.sel)'), '["a","b","c"]', 'a guest who pays is ticked');
  run(`A.fpay({dataset:{id:'b'}})`); assert.equal(run('JSON.stringify(F.sel)'), '["a","b"]', 'no longer ticked when somebody else pays');
  run(`A.fpay({dataset:{id:'c'}});A.fpart({dataset:{id:'c'}})`); assert.equal(run('JSON.stringify(F.sel)'), '["a","b"]', 'the author may untick the paying guest');
  run(`A.fdef({})`); assert.equal(run('JSON.stringify(F.sel)'), '["a","b","c"]', 'the default again includes the paying guest');
  run(`F.editId='e1';A.fpay({dataset:{id:'a'}})`); assert.equal(run('JSON.stringify(F.sel)'), '["a","b","c"]', 'editing keeps what was saved');
  run(`closeLayer();S.d.members.forEach((m,i)=>m.sub=i!==1);A.add({})`); assert.equal(run('JSON.stringify(F.sel)'), '["a","b"]', 'a guest author who pays is ticked');
  run(`A.fpay({dataset:{id:'c'}})`); assert.equal(run('JSON.stringify(F.sel)'), '["b","c"]', 'payer switches from guest a to guest c');
  run(`closeLayer();S.d.members.forEach((m,i)=>m.sub=i===2)`);
  // a room with nobody marked shows no box at all; ordinary members cannot change anything
  run(`S.d.members.forEach(m=>m.sub=false);A.add({})`); assert.doesNotMatch(form(), /subbox/); assert.equal(run('JSON.stringify(F.sel)'), '["a","b","c"]');
  run(`closeLayer();S.d.members[2].sub=true;S.d.me.role='member';S.d.me.admin=false;S.tab='members';render()`);
  assert.doesNotMatch(html(), /data-a="msub"/, 'only admins see the toggle'); assert.match(html(), /مهمان/);
});
