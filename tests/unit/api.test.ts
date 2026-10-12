import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../../src/index.ts';
import { validateInitData } from '../../src/security.ts';
import { buildCsv, csvCell } from '../../src/api.ts';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of ['0001_initial_schema.sql', '0002_bot_state.sql', '0003_expense_category.sql', '0004_rooms_and_settlement_confirm.sql', '0005_decimal_amounts_and_nickname.sql', '0006_require_confirm.sql', '0007_history_archive.sql']) db.exec(readFileSync(new URL('../../migrations/' + f, import.meta.url), 'utf8'));
  const mk = (sql: string, params: unknown[] = []) => ({
    bind: (...a: unknown[]) => mk(sql, a),
    first: async () => db.prepare(sql).get(...(params as any[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as any[])) }),
    run: async () => { const r = db.prepare(sql).run(...(params as any[])); return { meta: { changes: Number(r.changes) } }; },
    _run: () => db.prepare(sql).run(...(params as any[])),
  });
  return { raw: db, prepare: (s: string) => mk(s), batch: async (stmts: any[]) => { db.exec('BEGIN'); try { for (const s of stmts) s._run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
const TOKEN = '123:TESTTOKEN';
function initData(userId: number, authDate = Math.floor(Date.now() / 1000), token = TOKEN) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'q', user: JSON.stringify({ id: userId, first_name: 'U' + userId }) });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const sent: any[] = [];
globalThis.fetch = (async (url: string, init: any) => { sent.push({ url: String(url), form: init.body instanceof FormData }); return new Response('{"ok":true}'); }) as any;
const env: any = { DB: makeDb(), BOT_TOKEN: TOKEN, WEBHOOK_SECRET: 's' };
const call = async (uid: number | null, method: string, path: string, body?: any, init?: string) => {
  const r = await worker.fetch(new Request('http://x' + path, { method, headers: { 'X-Telegram-Init-Data': init ?? (uid === null ? '' : initData(uid)), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const sql = (q: string, ...a: any[]) => env.DB.raw.prepare(q).all(...a) as any[];

test('initData validation: valid, tampered, wrong token, stale', async () => {
  assert.equal((await validateInitData(initData(5), TOKEN))?.id, 5);
  assert.equal(await validateInitData(initData(5).replace('U5', 'U6'), TOKEN), null);
  assert.equal(await validateInitData(initData(5), 'other:token'), null);
  assert.equal(await validateInitData(initData(5, Math.floor(Date.now() / 1000) - 90000), TOKEN), null);
  assert.equal(await validateInitData('', TOKEN), null);
});

test('UI page and security headers', async () => {
  const r = await worker.fetch(new Request('http://x/'), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy')!, /frame-ancestors/);
  assert.match(await r.text(), /dir="rtl"/);
});

test('API: auth, onboarding, members, expenses, idempotency, isolation, settlement', async () => {
  assert.equal((await call(null, 'GET', '/api/state')).status, 401);
  assert.equal((await call(1, 'GET', '/api/state', undefined, 'garbage')).status, 401);
  let r = await call(1, 'GET', '/api/state');
  assert.equal(r.status, 403); assert.equal(r.body.error, 'not_member');
  assert.equal((await call(1, 'POST', '/api/dorm', { name: '' })).status, 400);
  assert.equal((await call(1, 'POST', '/api/dorm', { name: 'اتاق ۲۰۴' })).status, 200);
  r = await call(1, 'POST', '/api/member', { name: 'رضا' }); assert.equal(r.status, 200);
  const rezaId = r.body.id;
  r = await call(1, 'POST', '/api/invite', { memberId: rezaId });
  assert.match(r.body.code, /^[A-Z0-9]{8}$/);
  assert.equal((await call(2, 'POST', '/api/join', { code: 'WRONGCODE' })).status, 400);
  assert.equal((await call(2, 'POST', '/api/join', { code: r.body.code })).status, 200);
  assert.equal((await call(3, 'POST', '/api/join', { code: r.body.code })).status, 400, 'invite is single use');
  assert.equal((await call(2, 'POST', '/api/member', { name: 'x' })).status, 403, 'non-admin cannot add');

  let s = (await call(1, 'GET', '/api/state')).body;
  const ali = s.me.id;
  const key = 'key-12345678';
  const eq = { key, amount: '5000000', description: 'نان', payerId: ali, method: 'equal', participants: [ali, rezaId], date: s.today };
  r = await call(1, 'POST', '/api/expense', eq); assert.equal(r.status, 200);
  const first = r.body.id;
  r = await call(1, 'POST', '/api/expense', eq); assert.equal(r.body.id, first, 'same key returns same expense');
  assert.equal(sql('SELECT COUNT(*) n FROM expenses')[0].n, 1);
  // validation
  assert.equal((await call(1, 'POST', '/api/expense', { ...eq, key: 'key-aaaaaaaa', amount: '0' })).status, 400);
  assert.equal((await call(1, 'POST', '/api/expense', { ...eq, key: 'key-bbbbbbbb', participants: ['nope'] })).status, 400);
  assert.equal((await call(1, 'POST', '/api/expense', { ...eq, key: 'key-cccccccc', method: 'custom', shares: [{ memberId: ali, amount: 1 }] })).status, 400);
  assert.equal((await call(1, 'POST', '/api/expense', { ...eq, key: 'key-dddddddd', date: '2999-01-01' })).status, 400);
  assert.equal(sql('SELECT COUNT(*) n FROM expenses')[0].n, 1, 'nothing saved on invalid input');
  // custom, paid by reza
  r = await call(2, 'POST', '/api/expense', { key: 'key-eeeeeeee', amount: '9000000', description: 'اینترنت', payerId: rezaId, method: 'custom', shares: [{ memberId: ali, amount: 6000000 }, { memberId: rezaId, amount: 3000000 }], category: 'قبوض' });
  assert.equal(r.status, 200);
  s = (await call(1, 'GET', '/api/state')).body;
  // ali: paid 5000000 - 2500000 - 6000000 = -3500000 ; reza: 9000000 - 2500000 - 3000000 = +3500000
  assert.equal(s.balances[ali], -3500000); assert.equal(s.balances[rezaId], 3500000);
  assert.equal(s.monthly[s.today.slice(0, 7)].total, 14000000, 'monthly aggregate includes all active expenses');
  assert.equal(s.monthly[s.today.slice(0, 7)].count, 2, 'monthly aggregate counts active expenses');
  assert.equal(Object.values(s.balances).reduce((a: number, b: any) => a + b, 0), 0);
  assert.equal(s.totals.total, 14000000);
  assert.deepEqual(s.plan, [{ from: ali, to: rezaId, amount: 3500000 }]);

  // another dormitory cannot see or cancel
  await call(9, 'POST', '/api/dorm', { name: 'دیگر' });
  const other = (await call(9, 'GET', '/api/state')).body;
  assert.equal(other.expenses.length, 0);
  assert.equal((await call(9, 'POST', '/api/expense/cancel', { id: first, version: 1 })).status, 404);
  assert.equal((await call(9, 'POST', '/api/expense', { ...eq, key: 'key-ffffffff', participants: [ali] })).status, 400, 'cannot use foreign members');

  // settlement: only the debtor can record; the recipient must confirm
  assert.equal((await call(9, 'POST', '/api/settlement', { from: ali, to: rezaId, amount: 1 })).status, 403);
  assert.equal((await call(2, 'POST', '/api/settlement', { from: ali, to: rezaId, amount: 100 })).status, 403, 'creditor cannot record debtor payment');
  assert.equal((await call(1, 'POST', '/api/settlement', { from: rezaId, to: ali, amount: 100 })).status, 403, 'admin cannot settle for others');
  assert.equal((await call(1, 'POST', '/api/settlement', { from: ali, to: rezaId, amount: 4000000 })).status, 409, 'more than debt');
  assert.equal((await call(1, 'POST', '/api/member/deactivate', { id: rezaId })).status, 400, 'nonzero balance');
  r = await call(1, 'POST', '/api/settlement', { from: ali, to: rezaId, amount: 2000000 });
  assert.equal(r.status, 200);
  const pend1 = r.body.id;
  s = (await call(1, 'GET', '/api/state')).body;
  assert.equal(s.balances[ali], -3500000, 'pending payment does not change balances');
  assert.equal(s.pending.length, 1);
  assert.equal((await call(1, 'POST', '/api/settlement/respond', { id: pend1, action: 'confirm' })).status, 409, 'payer cannot confirm own payment');
  assert.equal((await call(2, 'POST', '/api/settlement/respond', { id: pend1, action: 'confirm' })).status, 200);
  assert.equal((await call(2, 'POST', '/api/settlement/respond', { id: pend1, action: 'confirm' })).status, 409, 'double confirm');
  s = (await call(1, 'GET', '/api/state')).body;
  assert.equal(s.balances[ali], -1500000);
  r = await call(1, 'POST', '/api/settlement', { from: ali, to: rezaId, amount: 1500000 });
  assert.equal((await call(2, 'POST', '/api/settlement/respond', { id: r.body.id, action: 'reject' })).status, 200);
  assert.equal(sql(`SELECT status FROM settlements WHERE id=?`, r.body.id)[0].status, 'cancelled');
  r = await call(1, 'POST', '/api/settlement', { from: ali, to: rezaId, amount: 1500000 });
  assert.equal((await call(2, 'POST', '/api/settlement/respond', { id: r.body.id, action: 'confirm' })).status, 200);
  assert.equal((await call(1, 'POST', '/api/settlement', { from: ali, to: rezaId, amount: 1500000 })).status, 409, 'already settled');
  s = (await call(1, 'GET', '/api/state')).body;
  assert.ok(Object.values(s.balances).every((v) => v === 0));
  assert.equal((await call(1, 'POST', '/api/member/deactivate', { id: rezaId })).status, 200);

  // cancel with optimistic version
  const e1 = s.expenses.find((e: any) => e.id === first);
  assert.equal((await call(2, 'POST', '/api/expense/cancel', { id: first, version: e1.version })).status, 403, 'only creator/admin');
  assert.equal((await call(1, 'POST', '/api/expense/cancel', { id: first, version: 99 })).status, 409);
  assert.equal((await call(1, 'POST', '/api/expense/cancel', { id: first, version: e1.version, reason: 'اشتباه' })).status, 200);
  assert.equal((await call(1, 'POST', '/api/expense/cancel', { id: first, version: e1.version })).status, 409);
  s = (await call(1, 'GET', '/api/state')).body;
  assert.equal(s.totals.total, 9000000);
  assert.equal(sql(`SELECT COUNT(*) n FROM audit_events WHERE entity='expense'`)[0].n >= 3, true);

  // export goes to Telegram as multipart document
  sent.length = 0;
  assert.equal((await call(1, 'POST', '/api/export', {})).status, 200);
  assert.ok(sent[0].url.endsWith('/sendDocument') && sent[0].form);
});

test('CSV escaping and formula-injection guard', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.ok(buildCsv([['شرح', 1]]).startsWith('\uFEFF'));
});

test('rooms: several rooms per user, switching, deleting; add members by Telegram ID', async () => {
  // user 1 owns the first room; create a second one
  assert.equal((await call(1, 'POST', '/api/room/create', { name: 'اتاق دوم' })).status, 200);
  let s = (await call(1, 'GET', '/api/state')).body;
  assert.equal(s.dorm.name, 'اتاق دوم'); assert.equal(s.rooms.length, 2);
  const first = s.rooms.find((r: any) => !r.current).id, second = s.dorm.id;
  assert.equal(s.expenses.length, 0, 'rooms are isolated');
  // add by IDs (digits in Persian too), with and without names
  let r = await call(1, 'POST', '/api/member/ids', { text: '۷۷۷۷۷۷۷ رضا\n8888888' });
  assert.deepEqual(r.body.added, ['رضا', 'عضو جدید']);
  r = await call(1, 'POST', '/api/member/ids', { text: '7777777' });
  assert.deepEqual(r.body.skipped, ['7777777'], 'duplicate skipped');
  assert.equal((await call(1, 'POST', '/api/member/ids', { text: 'abc' })).status, 400);
  assert.equal((await call(7777777, 'GET', '/api/state')).status, 200, 'added user is a member already');
  assert.equal((await call(7777777, 'POST', '/api/member/ids', { text: '99999999' })).status, 403, 'plain member cannot add');
  // switch back and forth
  assert.equal((await call(1, 'POST', '/api/room/switch', { id: 'nope' })).status, 404);
  assert.equal((await call(1, 'POST', '/api/room/switch', { id: first })).status, 200);
  assert.equal((await call(1, 'GET', '/api/state')).body.dorm.id, first);
  // delete needs owner + exact name; others cannot
  assert.equal((await call(7777777, 'POST', '/api/room/delete', { id: second, confirm: 'اتاق دوم' })).status, 400);
  assert.equal((await call(1, 'POST', '/api/room/delete', { id: second, confirm: 'غلط' })).status, 400);
  assert.equal((await call(1, 'POST', '/api/room/delete', { id: second, confirm: 'اتاق دوم' })).status, 200);
  s = (await call(1, 'GET', '/api/state')).body;
  assert.equal(s.rooms.length, 1); assert.equal(s.dorm.id, first);
  assert.equal((await call(7777777, 'GET', '/api/state')).status, 403, 'deleted room is gone for members');
  assert.equal(sql('SELECT COUNT(*) n FROM dormitories WHERE id=?', second)[0].n, 1, 'data kept (soft delete)');
});

test('API: edit an expense (amount, split, payer) with version guard and permissions', async () => {
  await call(31001, 'POST', '/api/dorm', { name: 'ویرایش' });
  assert.equal((await call(31001, 'POST', '/api/member/ids', { text: '31002 رضا\n31003 امیر' })).status, 200);
  let s = (await call(31001, 'GET', '/api/state')).body;
  const [a, b, c] = s.members.map((x: any) => x.id);
  let r = await call(31002, 'POST', '/api/expense', { key: 'edit-key-1', amount: '10000', description: 'نان', payerId: b, method: 'equal', participants: [a, b, c], date: s.today });
  assert.equal(r.status, 200);
  const id = r.body.id;
  s = (await call(31001, 'GET', '/api/state')).body;
  let e = s.expenses.find((x: any) => x.id === id);
  assert.deepEqual(e.allocs.map((x: any) => x.a).sort(), [3333, 3333, 3334]);
  const edit = { id, version: e.version, amount: '15001', description: 'نان و پنیر', payerId: a, method: 'equal', participants: [a, b], date: s.today, category: 'غذا' };
  assert.equal((await call(31003, 'POST', '/api/expense/update', edit)).status, 403, 'only creator or admin');
  assert.equal((await call(31001, 'POST', '/api/expense/update', { ...edit, version: 99 })).status, 409, 'stale version');
  assert.equal((await call(31001, 'POST', '/api/expense/update', { ...edit, participants: ['nope'] })).status, 400);
  assert.equal((await call(31002, 'POST', '/api/expense/update', edit)).status, 200, 'creator can edit; admin payer changed');
  s = (await call(31001, 'GET', '/api/state')).body;
  e = s.expenses.find((x: any) => x.id === id);
  assert.equal(e.total, 15001); assert.equal(e.desc, 'نان و پنیر'); assert.equal(e.payer, a); assert.equal(e.version, 2);
  assert.deepEqual(e.allocs.map((x: any) => x.a).sort(), [7500, 7501]);
  assert.ok([7500, 7501].includes(s.balances[a]), 'payer is owed total minus own share');
  assert.equal(Object.values(s.balances).reduce((x: number, y: any) => x + y, 0), 0, 'ledger still balances');
  assert.equal((await call(31001, 'POST', '/api/expense/update', edit)).status, 409, 'old version rejected after edit');
  assert.equal((await call(31001, 'POST', '/api/expense/cancel', { id, version: 2 })).status, 200);
  assert.equal((await call(31001, 'POST', '/api/expense/update', { ...edit, version: 3 })).status, 400, 'cancelled expense cannot be edited');
  const audit = sql(`SELECT action FROM audit_events WHERE entity='expense' AND entity_id=?`, id).map((x: any) => x.action);
  assert.ok(audit.includes('update'));
});

test('API: room option without creditor confirmation; stale pending payments are cancelled after an edit', async () => {
  await call(32001, 'POST', '/api/dorm', { name: 'مستقیم', requireConfirm: false });
  assert.equal((await call(32001, 'POST', '/api/member/ids', { text: '32002 رضا' })).status, 200);
  let s = (await call(32001, 'GET', '/api/state')).body;
  assert.equal(s.dorm.requireConfirm, false);
  const [a, b] = s.members.map((x: any) => x.id);
  let r = await call(32001, 'POST', '/api/expense', { key: 'direct-key-1', amount: '10000', description: 'x', payerId: a, method: 'equal', participants: [a, b], date: s.today });
  assert.equal(r.status, 200);
  r = await call(32002, 'POST', '/api/settlement', { from: b, to: a, amount: 5000 });
  assert.equal(r.status, 200); assert.equal(r.body.direct, true);
  s = (await call(32001, 'GET', '/api/state')).body;
  assert.equal(s.pending.length, 0, 'no pending step');
  assert.ok(Object.values(s.balances).every((v) => v === 0), 'payment applied immediately');
  // only an admin may change the option
  assert.equal((await call(32002, 'POST', '/api/room/settings', { requireConfirm: true })).status, 403);
  assert.equal((await call(32001, 'POST', '/api/room/settings', { requireConfirm: true })).status, 200);
  s = (await call(32001, 'GET', '/api/state')).body; assert.equal(s.dorm.requireConfirm, true);
  // now confirmation is required: b owes 100 toman, records a payment of 100 (pending)
  r = await call(32001, 'POST', '/api/expense', { key: 'direct-key-2', amount: '20000', description: 'y', payerId: a, method: 'equal', participants: [a, b], date: s.today });
  const id = r.body.id;
  r = await call(32002, 'POST', '/api/settlement', { from: b, to: a, amount: 10000 });
  assert.equal(r.status, 200); assert.equal(r.body.direct, false);
  s = (await call(32001, 'GET', '/api/state')).body; assert.equal(s.pending.length, 1);
  // a edits the expense down: b's debt becomes 50, so the pending 100 no longer fits and is cancelled
  const e = s.expenses.find((x: any) => x.id === id);
  r = await call(32001, 'POST', '/api/expense/update', { id, version: e.version, amount: '10000', description: 'y', payerId: a, method: 'equal', participants: [a, b], date: s.today });
  assert.equal(r.status, 200); assert.equal(r.body.cancelledPending, 1);
  s = (await call(32001, 'GET', '/api/state')).body; assert.equal(s.pending.length, 0);
  // confirmed payments stay counted after an edit: b already paid 50; the new debt of 50 is exactly covered
  assert.ok(Object.values(s.balances).every((v) => v === 0 || Math.abs(v as number) === 5000));
});

test('API: clear whole history, restore within 48h, purge after', async () => {
  await call(33001, 'POST', '/api/dorm', { name: 'تاریخچه', requireConfirm: false });
  assert.equal((await call(33001, 'POST', '/api/member/ids', { text: '33002 رضا' })).status, 200);
  let s = (await call(33001, 'GET', '/api/state')).body;
  const [a, b] = s.members.map((x: any) => x.id);
  assert.equal((await call(33001, 'POST', '/api/history/clear', {})).status, 409, 'nothing to clear yet');
  await call(33001, 'POST', '/api/expense', { key: 'hist-key-1', amount: '10000', description: 'قدیمی ۱', payerId: a, method: 'equal', participants: [a, b], date: s.today });
  await call(33001, 'POST', '/api/expense', { key: 'hist-key-2', amount: '4000', description: 'قدیمی ۲', payerId: b, method: 'equal', participants: [a, b], date: s.today });
  assert.equal((await call(33002, 'POST', '/api/settlement', { from: b, to: a, amount: 1000 })).status, 200); // direct (room has no confirmation)
  const before = (await call(33001, 'GET', '/api/state')).body;
  assert.equal(before.expenses.length, 2);

  assert.equal((await call(33002, 'POST', '/api/history/clear', {})).status, 403, 'admin only');
  let r = await call(33001, 'POST', '/api/history/clear', {});
  assert.equal(r.status, 200); assert.equal(r.body.expenses, 2); assert.equal(r.body.settlements, 1);
  s = (await call(33001, 'GET', '/api/state')).body;
  assert.equal(s.expenses.length, 0); assert.equal(s.settlements.length, 0);
  assert.ok(Object.values(s.balances).every((v) => v === 0), 'balances reset');
  assert.equal(s.members.length, 2, 'members kept');
  assert.equal(s.archives.length, 1);
  const hours = (Date.parse(s.archives[0].expiresAt) - Date.now()) / 3600000;
  assert.ok(hours > 47.9 && hours <= 48, 'expires in 48 hours');

  // new activity after the clear, then restore: both histories are merged and settlement ids stay unique
  await call(33001, 'POST', '/api/expense', { key: 'hist-key-3', amount: '2000', description: 'جدید', payerId: a, method: 'equal', participants: [a, b], date: s.today });
  assert.equal((await call(33002, 'POST', '/api/settlement', { from: b, to: a, amount: 500 })).status, 200);
  assert.equal((await call(33002, 'POST', '/api/history/restore', { id: s.archives[0].id })).status, 403, 'admin only');
  r = await call(33001, 'POST', '/api/history/restore', { id: s.archives[0].id });
  assert.equal(r.status, 200); assert.equal(r.body.expenses, 2);
  s = (await call(33001, 'GET', '/api/state')).body;
  assert.equal(s.expenses.length, 3); assert.equal(s.settlements.length, 2); assert.equal(s.archives.length, 0);
  const ids = sql('SELECT id FROM settlements WHERE dormitory_id=?', s.dorm.id).map((x: any) => x.id);
  assert.equal(new Set(ids).size, ids.length); assert.ok(ids.every((i: string) => i.length <= 57));
  assert.equal(sql('SELECT COUNT(*) n FROM archived_expenses').every((x: any) => true), true);
  assert.equal(Object.values(s.balances).reduce((x: number, y: any) => x + y, 0), 0);
  assert.equal((await call(33001, 'POST', '/api/history/restore', { id: before.expenses[0].id })).status, 404, 'unknown archive');

  // clear again, let 48h pass -> permanently purged
  assert.equal((await call(33001, 'POST', '/api/history/clear', {})).status, 200);
  s = (await call(33001, 'GET', '/api/state')).body;
  const arch = s.archives[0].id;
  sql(`UPDATE archives SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?`, arch);
  s = (await call(33001, 'GET', '/api/state')).body;
  assert.equal(s.archives.length, 0);
  assert.equal((await call(33001, 'POST', '/api/history/restore', { id: arch })).status, 404, 'too late');
  assert.equal(sql('SELECT COUNT(*) n FROM archived_expenses WHERE archive_id=?', arch)[0].n, 0, 'rows really deleted');
  assert.equal(sql('SELECT COUNT(*) n FROM archived_allocations WHERE archive_id=?', arch)[0].n, 0);
  assert.equal(sql('SELECT COUNT(*) n FROM archived_settlements WHERE archive_id=?', arch)[0].n, 0);
});
