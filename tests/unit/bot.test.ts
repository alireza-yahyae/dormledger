import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../src/index.ts';

// Minimal D1 shim over node:sqlite (batch = one transaction, like D1).
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

const sent: any[] = [];
globalThis.fetch = (async (url: string, init: any) => { sent.push({ method: String(url).split('/').pop(), ...JSON.parse(init.body) }); return new Response('{"ok":true}'); }) as any;
let uid = 0;
const env: any = { DB: makeDb(), BOT_TOKEN: 't', WEBHOOK_SECRET: 'sec' };
const post = (u: any, secret = 'sec') => worker.fetch(new Request('http://x/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(u) }), env);
const say = async (from: number, text: string, type = 'private') => { sent.length = 0; await post({ update_id: ++uid, message: { from: { id: from, first_name: 'U' + from }, chat: { id: from, type }, text } }); return sent.filter((s) => s.method === 'sendMessage'); };
const press = async (from: number, data: string) => { sent.length = 0; await post({ update_id: ++uid, callback_query: { id: 'c' + uid, from: { id: from }, message: { chat: { id: from } }, data } }); return sent.filter((s) => s.method === 'sendMessage'); };
const last = (r: any[]) => r[r.length - 1];
const sql = (q: string, ...a: any[]) => env.DB.raw.prepare(q).all(...a);

test('webhook security and health', async () => {
  assert.equal((await post({ update_id: 1 }, 'bad')).status, 403);
  assert.equal((await worker.fetch(new Request('http://x/health'), env)).status, 200);
});

test('full flow: create dorm, members, equal + custom expenses, balances, settle, duplicates', async () => {
  await say(100, '/start'); await press(100, 'start:new');
  let r = await say(100, 'خوابگاه تست');
  assert.ok(r.some((x: any) => /ساخته شد/.test(x.text)));
  await say(100, '/addmember رضا');
  await say(100, '/addmember امیر');
  r = await say(100, '/members');
  assert.match(last(r).text, /1\. U100 \(مدیر\)/);
  assert.match(last(r).text, /2\. رضا — هنوز/);
  // invite linked to member #2, join by second telegram user
  r = await say(100, '/invite ۲');
  const code = last(r).text.match(/\n([A-Z0-9]{8})\n/)[1];
  r = await say(200, '/join ' + code);
  assert.ok(r.some((x: any) => /پیوستید/.test(x.text)));
  r = await say(300, '/join ' + code); // single use
  assert.match(last(r).text, /نامعتبر/);
  assert.equal(sql('SELECT telegram_user_id FROM members WHERE display_name=?', 'رضا')[0].telegram_user_id, 200);

  const ms = sql('SELECT id, display_name FROM members ORDER BY rowid');
  const [ali, reza, amir] = ms.map((m: any) => m.id);

  // equal expense: ali pays 50,000, all three participate (150001 would test remainder separately)
  await say(100, '/add');
  r = await say(100, '۵۰٬۰۰۰'); assert.match(last(r).text, /شرح/);
  await say(100, 'نان و پنیر');
  r = await press(100, 'p:' + ali); assert.match(last(r).text, /روش/);
  await press(100, 'm:eq');
  await press(100, 't:' + amir); // deselect amir
  r = await press(100, 't:ok');
  assert.match(last(r).text, /مبلغ کل: ۵۰٬۰۰۰ تومان/);
  assert.match(last(r).text, /تعداد شرکت‌کنندگان: 2/.source ? /تعداد شرکت‌کنندگان: ۲|تعداد شرکت‌کنندگان: 2/ : /x/);
  assert.equal(sql('SELECT COUNT(*) n FROM expenses')[0].n, 0, 'nothing saved before confirm');
  r = await press(100, 'c:ok');
  assert.match(last(r).text, /ذخیره شد/);
  const dupe = await press(100, 'c:ok'); // double click
  assert.ok(!dupe.some((x: any) => /ذخیره شد/.test(x.text)));
  assert.equal(sql('SELECT COUNT(*) n FROM expenses')[0].n, 1);
  assert.deepEqual(sql('SELECT member_id, amount FROM expense_allocations ORDER BY amount, member_id').map((x: any) => x.amount), [2500000, 2500000]);

  // custom expense: reza pays 90,000: ali 30,000, reza 20,000, amir 40,000 ; wrong sum first
  await say(200, '/add'); await say(200, '90000'); await say(200, 'اینترنت');
  await press(200, 'p:' + reza); await press(200, 'm:cu');
  r = await say(200, '1=30000 2=20000 3=30000');
  assert.match(last(r).text, /کمتر|بیشتر/);
  assert.equal(sql('SELECT COUNT(*) n FROM expenses')[0].n, 1);
  await say(200, '1=30000 2=20000 3=40000');
  await press(200, 'c:ok');
  assert.equal(sql('SELECT COUNT(*) n FROM expenses')[0].n, 2);

  // net: ali +50000-25000-30000=-5000 ; reza +90000-25000-20000=+45000 ; amir -40000
  r = await say(100, '/balance');
  assert.match(last(r).text, /تراز شما: .*بدهکار/);
  r = await say(100, '/settle');
  const kb = last(r).reply_markup.inline_keyboard.flat();
  assert.equal(kb.length, 1, 'only my own debt has a pay button');
  const payBtn = kb[0];
  // a stranger / someone else cannot record this payment
  r = await say(400, '/start'); await press(400, 'start:new'); await say(400, 'خوابگاه دیگر');
  r = await press(400, payBtn.callback_data);
  assert.match(last(r).text, /فقط خودِ بدهکار/);
  r = await press(200, payBtn.callback_data); // reza is not the debtor
  assert.match(last(r).text, /فقط خودِ بدهکار/);
  // debtor records -> pending, balances unchanged until recipient confirms
  const before = sql('SELECT COUNT(*) n FROM settlements WHERE status=?', 'confirmed')[0].n;
  r = await press(100, payBtn.callback_data); assert.match(last(r).text, /ثبت شد/);
  const notif = sent.find((x: any) => x.chat_id === 200 && JSON.stringify(x.reply_markup).includes('sc:ok:'));
  assert.ok(notif, 'recipient was asked to confirm');
  assert.equal(sql('SELECT COUNT(*) n FROM settlements WHERE status=?', 'confirmed')[0].n, before);
  r = await press(100, payBtn.callback_data); assert.match(last(r).text, /بیشتر از بدهی/, 'no second pending for same debt');
  const scOk = notif.reply_markup.inline_keyboard[0][0].callback_data;
  r = await press(100, scOk); assert.match(last(r).text, /فقط دریافت‌کننده/, 'payer cannot confirm own payment');
  r = await press(200, scOk); assert.match(last(r).text, /تأیید شد/);
  r = await press(200, scOk); assert.match(last(r).text, /دیگر در انتظار/);
  assert.equal(sql('SELECT COUNT(*) n FROM settlements WHERE status=?', 'confirmed')[0].n, before + 1);
  // other dorm (user 400) sees nothing from dorm 1
  r = await say(400, '/expenses'); assert.match(last(r).text, /هنوز هزینه‌ای/);

  // webhook retry of the same update is ignored
  sent.length = 0;
  await post({ update_id: 777, message: { from: { id: 100 }, chat: { id: 100, type: 'private' }, text: '/help' } });
  const n1 = sent.length;
  await post({ update_id: 777, message: { from: { id: 100 }, chat: { id: 100, type: 'private' }, text: '/help' } });
  assert.equal(sent.length, n1);

  // group chat: no financial output
  r = await say(100, '/balance', 'group');
  assert.match(last(r).text, /پیام خصوصی/);

  // ledger invariant from DB
  const tot = sql(`SELECT (SELECT SUM(total_amount) FROM expenses) t, (SELECT SUM(amount) FROM expense_allocations) a`)[0];
  assert.equal(tot.t, tot.a);
});

test('button-driven UI: start buttons, reply-keyboard labels, add member + invite via buttons', async () => {
  let r = await say(900, '/start');
  const kb = last(r).reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.deepEqual(kb, ['start:new', 'start:join']);
  await press(900, 'start:new');
  env.APP_URL = 'https://dormledger.example.workers.dev';
  r = await say(900, 'خوابگاه دکمه‌ای');
  env.APP_URL = '';
  const kbMsg = r.find((x: any) => x.reply_markup?.keyboard);
  assert.ok(kbMsg, 'persistent bottom keyboard shown');
  assert.deepEqual(kbMsg.reply_markup.keyboard[0][0], { text: '🚀 باز کردن DormLedger' }, 'plain text button (a web_app reply button gives the Mini App no initData)');
  env.APP_URL = 'https://dormledger.example.workers.dev';
  r = await say(900, '🚀 باز کردن DormLedger');
  env.APP_URL = '';
  assert.equal(last(r).reply_markup.inline_keyboard[0][0].web_app.url, 'https://dormledger.example.workers.dev', 'button reply opens the Mini App via an inline web_app button');
  r = await press(900, 'mem:add'); assert.match(last(r).text, /نام عضو/);
  r = await say(900, 'سارا'); assert.match(last(r).text, /اضافه شد/);
  const inv = last(r).reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data.startsWith('inv:'));
  r = await press(900, inv.callback_data);
  const code = last(r).text.match(/\n([A-Z0-9]{8})\n/)[1];
  await say(901, '/start'); await press(901, 'start:join');
  r = await say(901, code); assert.ok(r.some((x: any) => /پیوستید/.test(x.text)));
  r = await say(900, 'اعضا'); assert.match(last(r).text, /سارا/);
  r = await say(900, 'تراز'); assert.match(last(r).text, /تراز/);
  r = await press(901, 'mem:add'); assert.match(last(r).text, /فقط مدیر/);
  r = await say(900, 'ثبت هزینه'); assert.match(last(r).text, /مبلغ/);
});

test('bot: add members by Telegram ID / shared users, multiple rooms, delete room', async () => {
  await say(8850, '/start'); await press(8850, 'start:new'); await say(8850, 'اتاق اول');
  let r = await press(8850, 'mem:ids');
  assert.ok(last(r).reply_markup.keyboard[0][0].request_users, 'contact picker button offered');
  r = await say(8850, '۵۵۵۱۲۳۴ رضا\n6667890'); assert.match(last(r).text, /اضافه شد: رضا، عضو جدید/);
  r = await say(5551234, '/start'); assert.match(last(r).text, /اتاق اول/, 'added user is already a member');
  // shared users via Telegram contact picker
  await press(8850, 'mem:ids');
  sent.length = 0;
  await post({ update_id: ++uid, message: { from: { id: 8850 }, chat: { id: 8850, type: 'private' }, users_shared: { request_id: 1, users: [{ user_id: 7770001, first_name: 'ممد' }] } } });
  assert.match(sent.filter((x: any) => x.method === 'sendMessage').pop().text, /اضافه شد: ممد/);
  // a plain member cannot add
  await press(5551234, 'mem:ids');
  r = await press(5551234, 'mem:ids'); assert.match(last(r).text, /فقط مدیر/);
  // second room, switch, rooms list, delete
  await press(8850, 'room:new'); await say(8850, 'اتاق دوم');
  r = await say(8850, 'اتاق‌ها');
  assert.equal(last(r).reply_markup.inline_keyboard.filter((row: any) => row[0].callback_data.startsWith('room:go:')).length, 2);
  const goFirst = last(r).reply_markup.inline_keyboard.find((row: any) => row[0].text.includes('اتاق اول'))[0].callback_data;
  r = await press(8850, goFirst); assert.match(last(r).text, /اتاق «اتاق اول»/);
  r = await press(5551234, 'room:del'); assert.match(last(r).text, /فقط مدیر اصلی/);
  r = await press(8850, 'room:del'); assert.match(last(r).text, /حذف شود/);
  const delBtn = last(r).reply_markup.inline_keyboard[0][0].callback_data;
  r = await press(8850, delBtn); assert.match(last(r).text, /اتاق حذف شد.*اتاق دوم/s);
  r = await say(5551234, '/start'); assert.match(last(r).text, /ابتدا|چه کار|سلام!/, 'member of deleted room has no room');
});

test('profile: name + nickname after create, /name, /nickname, left-aligned members list', async () => {
  await say(7123, '/start'); await press(7123, 'start:new');
  let r = await say(7123, 'خوابگاه پروفایل');
  assert.match(last(r).text, /تأیید کند/, 'asks whether creditor confirmation is required');
  assert.deepEqual(last(r).reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data), ['rc:1', 'rc:0']);
  r = await press(7123, 'rc:0');
  assert.equal(sql('SELECT require_confirm c FROM dormitories d JOIN members m ON m.dormitory_id=d.id WHERE m.telegram_user_id=?', 7123)[0].c, 0);
  assert.match(last(r).text, /نام شما/);
  r = await say(7123, 'علی رضایی'); assert.match(last(r).text, /مستعار/);
  r = await say(7123, 'ابوعلی'); assert.ok(r.some((x: any) => /ذخیره شد/.test(x.text)));
  const row = sql('SELECT display_name, nickname FROM members WHERE telegram_user_id=?', 7123)[0];
  assert.equal(row.display_name, 'علی رضایی'); assert.equal(row.nickname, 'ابوعلی');
  r = await say(7123, '/members');
  assert.ok(last(r).text.startsWith('\u200e'), 'LRM prefix');
  assert.ok(last(r).text.split('\n').every((l: string) => l.startsWith('\u200e')), 'every line left-to-right');
  assert.match(last(r).text, /1\. علی رضایی — مستعار: ابوعلی \(مدیر\)/);
  r = await say(7123, '/name سارا'); assert.match(last(r).text, /سارا/);
  r = await say(7123, '/nickname -'); assert.match(last(r).text, /حذف/);
  assert.equal(sql('SELECT nickname FROM members WHERE telegram_user_id=?', 7123)[0].nickname, null);
});

test('bot: /clearhistory and /restorehistory (admin only, confirm, 48h)', async () => {
  await say(7300, '/start'); await press(7300, 'start:new');
  await say(7300, 'خوابگاه تاریخچه'); await press(7300, 'rc:1');
  let r = await say(7300, '/clearhistory');
  assert.deepEqual(last(r).reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data), ['ch:go', 'ch:no']);
  r = await press(7300, 'ch:go'); assert.match(last(r).text, /وجود ندارد/, 'nothing to clear');
  const m = sql('SELECT id, dormitory_id FROM members WHERE telegram_user_id=?', 7300)[0];
  env.DB.raw.prepare(`INSERT INTO expenses(id,dormitory_id,description,total_amount,payer_id,method,expense_date,created_by) VALUES('hx',?,'نان',10000,?,'equal','2026-10-10',?)`).run(m.dormitory_id, m.id, m.id);
  env.DB.raw.prepare(`INSERT INTO expense_allocations(expense_id,member_id,amount) VALUES('hx',?,10000)`).run(m.id);
  r = await press(7300, 'ch:no'); assert.match(last(r).text, /انصراف/);
  assert.equal(sql('SELECT COUNT(*) n FROM expenses')[0].n >= 1, true);
  r = await press(7300, 'ch:go'); assert.match(last(r).text, /پاک شد/);
  assert.equal(sql('SELECT COUNT(*) n FROM expenses WHERE id=?', 'hx')[0].n, 0);
  r = await say(7300, '/restorehistory');
  const btn = last(r).reply_markup.inline_keyboard[0][0];
  assert.match(btn.text, /ساعت مانده/); assert.match(btn.callback_data, /^ch:undo:/);
  r = await press(7300, btn.callback_data); assert.match(last(r).text, /بازگردانده شد/);
  assert.equal(sql('SELECT COUNT(*) n FROM expenses WHERE id=?', 'hx')[0].n, 1);
  assert.equal(sql('SELECT COUNT(*) n FROM expense_allocations WHERE expense_id=?', 'hx')[0].n, 1);
});
