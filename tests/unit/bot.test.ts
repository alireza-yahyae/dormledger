import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../src/index.ts';

// Minimal D1 shim over node:sqlite (batch = one transaction, like D1).
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of ['0001_initial_schema.sql', '0002_bot_state.sql', '0003_expense_category.sql', '0004_rooms_and_settlement_confirm.sql', '0005_decimal_amounts_and_nickname.sql', '0006_require_confirm.sql', '0007_history_archive.sql', '0008_consent_rounding.sql', '0009_substitute_members.sql']) db.exec(readFileSync(new URL('../../migrations/' + f, import.meta.url), 'utf8'));
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
/** Like Telegram: an inline button whose callback_data is empty or longer than 64 bytes makes the WHOLE message fail (BUTTON_DATA_INVALID). */
const badButtons: string[] = [];
globalThis.fetch = (async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  for (const row of body.reply_markup?.inline_keyboard ?? []) for (const b of row) {
    const n = b.callback_data === undefined ? 1 : Buffer.byteLength(b.callback_data);
    if (n < 1 || n > 64) { badButtons.push(`${b.callback_data} (${n} bytes)`); return new Response('{"ok":false,"description":"BUTTON_DATA_INVALID"}', { status: 400 }); }
  }
  sent.push({ method: String(url).split('/').pop(), ...body }); return new Response('{"ok":true}');
}) as any;
let uid = 0;
const env: any = { DB: makeDb(), BOT_TOKEN: 't', WEBHOOK_SECRET: 'sec' };
const post = (u: any, secret = 'sec') => worker.fetch(new Request('http://x/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(u) }), env);
const say = async (from: number, text: string, type = 'private') => { sent.length = 0; await post({ update_id: ++uid, message: { from: { id: from, first_name: 'U' + from }, chat: { id: from, type }, text } }); assert.deepEqual(badButtons.splice(0), [], 'every button must fit Telegram limits'); return sent.filter((s) => s.method === 'sendMessage'); };
const press = async (from: number, data: string, messageId?: number) => { sent.length = 0; await post({ update_id: ++uid, callback_query: { id: 'c' + uid, from: { id: from }, message: { chat: { id: from }, ...(messageId ? { message_id: messageId } : {}) }, data } }); assert.deepEqual(badButtons.splice(0), [], 'every button must fit Telegram limits'); return sent.filter((s) => s.method === 'sendMessage'); };
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
  // the button only carries the recipient + amount; whoever taps can record only THEIR OWN payment
  assert.match(payBtn.callback_data, /^pay:[0-9a-f-]{36}:\d+$/);
  r = await press(400, payBtn.callback_data);
  assert.match(last(r).text, /بیشتر از بدهی شماست|بدهی‌ای وجود ندارد/);
  r = await press(200, payBtn.callback_data); // reza is the recipient, not a debtor
  assert.match(last(r).text, /بیشتر از بدهی شماست|بدهی‌ای وجود ندارد/);
  assert.equal(sql('SELECT COUNT(*) n FROM settlements')[0].n, 0, 'nobody else could record the payment');
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
  r = await say(8850, '۵۵۵۱۲۳۴ رضا\n6667890'); assert.match(last(r).text, /درخواست عضویت برای رضا، عضو جدید/);
  const dmTo = (id: number) => sent.find((x: any) => x.method === 'sendMessage' && x.chat_id === id);
  const yes = dmTo(5551234).reply_markup.inline_keyboard[0][0].callback_data, no = dmTo(6667890).reply_markup.inline_keyboard[0][1].callback_data;
  assert.match(yes, /^mr:ok:/); assert.match(no, /^mr:no:/);
  assert.equal(sql('SELECT COUNT(*) n FROM members WHERE telegram_user_id IN (5551234,6667890)')[0].n, 0, 'nobody is added without consent');
  r = await press(9999, yes); assert.match(last(r).text, /پیدا نشد/, 'a stranger cannot answer for them');
  r = await press(5551234, yes); assert.match(last(r).text, /پیوستید/);
  assert.ok(r.some((x: any) => x.chat_id === 8850 && /پذیرفت/.test(x.text)), 'the admin is told');
  r = await press(5551234, yes); assert.match(last(r).text, /دیگر معتبر نیست/, 'replaying the button does nothing');
  r = await press(6667890, no); assert.match(last(r).text, /رد شد/);
  assert.equal(sql('SELECT COUNT(*) n FROM members WHERE telegram_user_id=6667890')[0].n, 0, 'declined stays out');
  r = await say(5551234, '/start'); assert.match(last(r).text, /اتاق اول/, 'accepted user is a member');
  // shared users via Telegram contact picker
  await press(8850, 'mem:ids');
  sent.length = 0;
  await post({ update_id: ++uid, message: { from: { id: 8850 }, chat: { id: 8850, type: 'private' }, users_shared: { request_id: 1, users: [{ user_id: 7770001, first_name: 'ممد' }] } } });
  assert.match(sent.filter((x: any) => x.method === 'sendMessage').find((x: any) => x.chat_id === 8850).text, /درخواست عضویت برای ممد/);
  await press(7770001, dmTo(7770001).reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal(sql('SELECT COUNT(*) n FROM members WHERE telegram_user_id=7770001')[0].n, 1);
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

test('A15: someone who opens the bot only after being invited sees the pending request on /start', async () => {
  await say(92000, '/start'); await press(92000, 'start:new'); await say(92000, 'اتاق دیرآمده');
  await press(92000, 'mem:ids');
  const realFetch = globalThis.fetch; // Telegram refuses the DM: they never opened the bot
  globalThis.fetch = (async (url: string, init: any) => { sent.push({ method: String(url).split('/').pop(), ...JSON.parse(init.body) }); return new Response('{"ok":false}', { status: 403 }); }) as any;
  let r = await say(92000, '92001 سارا');
  globalThis.fetch = realFetch;
  assert.match(last(r).text, /پیام به سارا نرسید/);
  r = await say(92001, '/start');
  const offer = r.find((x: any) => /دعوت/.test(x.text) && x.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('mr:ok:'));
  assert.ok(offer, 'pending request is offered on /start');
  r = await press(92001, offer.reply_markup.inline_keyboard[0][0].callback_data); assert.match(last(r).text, /اتاق دیرآمده/);
  assert.equal(sql('SELECT display_name FROM members WHERE telegram_user_id=92001')[0].display_name, 'سارا');
});

test('B1 bot: /add notifies the others; B14: /leave with confirm; hidden /backup is owner-only', async () => {
  await say(91000, '/start'); await press(91000, 'start:new'); await say(91000, 'اتاق اعلان');
  await press(91000, 'mem:ids');
  await say(91000, '91001 رضا\n91002 امیر');
  for (const t of [91001, 91002]) await press(t, sql(`SELECT id FROM member_requests WHERE telegram_user_id=? AND status='pending'`, t)[0] && 'mr:ok:' + sql(`SELECT id FROM member_requests WHERE telegram_user_id=? AND status='pending'`, t)[0].id);
  const mid = sql('SELECT id FROM members WHERE telegram_user_id=91000')[0].id;
  await say(91000, '/add'); await say(91000, '300000'); await say(91000, 'پیتزا');
  await press(91000, 'p:' + mid); await press(91000, 'm:eq');
  const r = await press(91000, 't:ok'); assert.ok(last(r));
  const done = await press(91000, 'c:ok');
  assert.match(last(done).text, /هزینه ذخیره شد/, "the author's own confirmation is still last");
  const ntf = (id: number) => done.filter((x: any) => x.chat_id === id && /پیتزا/.test(x.text));
  assert.equal(ntf(91000).length, 0, 'author gets no notification');
  assert.match(ntf(91001)[0].text, /سهم شما/); assert.match(ntf(91002)[0].text, /پرداخت‌کننده: علی|پرداخت‌کننده: U91000/);
  // leave: the owner cannot, a member with a balance cannot, a settled member can
  assert.match(last(await say(91000, '/leave')).text, /مدیر اصلی/);
  let l = await say(91001, '/leave'); assert.equal(last(l).reply_markup.inline_keyboard[0][0].callback_data, 'lv:go');
  assert.match(last(await press(91001, 'lv:go')).text, /تراز/, 'owes money');
  assert.match(last(await press(91001, 'lv:no')).text, /می‌مانید/);
  await say(93000, '/start'); // outsider, then added after the expense -> zero balance
  await press(91000, 'mem:ids'); await say(91000, '93000 نیما');
  await press(93000, 'mr:ok:' + sql(`SELECT id FROM member_requests WHERE telegram_user_id=93000 AND status='pending'`)[0].id);
  await say(93000, '/leave'); const out = await press(93000, 'lv:go');
  assert.match(last(out).text, /خارج شدید/);
  assert.ok(out.some((x: any) => x.chat_id === 91000 && /خارج شد/.test(x.text)), 'owner is told');
  assert.equal(sql('SELECT active FROM members WHERE telegram_user_id=93000')[0].active, 0);
  assert.match(last(await say(91000, '/backup')).text, /ناشناخته/, '/backup is hidden from everyone but BACKUP_CHAT_ID');
});

test('bot settle: debtors get a working "I paid" button, others get guidance, an admin answers for a member without Telegram', async () => {
  await say(50000, '/start'); await press(50000, 'start:new'); await say(50000, 'اتاق تسویه'); await press(50000, 'rc:1');
  await say(50000, '/addmember سارا');
  await press(50000, 'mem:ids'); await say(50000, '50010 رضا\n50020 نیما');
  for (const t of [50010, 50020]) await press(t, 'mr:ok:' + sql(`SELECT id FROM member_requests WHERE telegram_user_id=? AND status='pending'`, t)[0].id);
  const dorm = sql('SELECT dormitory_id d FROM members WHERE telegram_user_id=50000')[0].d as string;
  const byTg = (t: number) => sql('SELECT id FROM members WHERE telegram_user_id=?', t)[0].id as string;
  const admin = byTg(50000), reza = byTg(50010), sara = sql(`SELECT id FROM members WHERE dormitory_id=? AND display_name='سارا'`, dorm)[0].id as string;
  // sara (not on Telegram) paid 60,000 for the three of them -> admin and reza owe her 20,000 each
  env.DB.raw.prepare(`INSERT INTO expenses(id,dormitory_id,description,total_amount,payer_id,method,expense_date,created_by) VALUES('sx1',?,'پیتزا',6000000,?,'equal','2026-10-10',?)`).run(dorm, sara, sara);
  for (const m of [admin, reza, sara]) env.DB.raw.prepare(`INSERT INTO expense_allocations(expense_id,member_id,amount) VALUES('sx1',?,2000000)`).run(m);

  let r = await say(50020, '/settle'); // nima: no debt, no credit
  assert.match(last(r).text, /بدهی یا طلبی ندارید/);
  assert.equal(last(r).reply_markup, undefined, 'nothing to press');

  r = await say(50010, '/settle'); // reza owes sara
  assert.match(last(r).text, /برای تأیید به طلب‌کار برود/);
  const pay = last(r).reply_markup.inline_keyboard.flat();
  assert.equal(pay.length, 1); assert.match(pay[0].callback_data, /^pay:/);
  assert.ok(Buffer.byteLength(pay[0].callback_data) <= 64);
  r = await press(50010, pay[0].callback_data);
  assert.match(last(r).text, /ثبت شد/); assert.match(last(r).text, /مدیر باید/, 'sara is not on Telegram: an admin must confirm');
  assert.equal(sql(`SELECT COUNT(*) n FROM settlements WHERE status='pending' AND from_member_id=? AND to_member_id=?`, reza, sara)[0].n, 1);

  r = await say(50000, '/settle'); // the admin owes too, AND can answer for sara
  const kb = last(r).reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b: any) => b.callback_data.startsWith('pay:')), 'own debt can be paid from the bot');
  const ok = kb.find((b: any) => b.callback_data.startsWith('sc:ok:'));
  assert.ok(ok, 'admin can confirm on behalf of a member who is not on Telegram');
  r = await press(50020, ok.callback_data); assert.match(last(r).text, /فقط دریافت‌کننده/, 'an ordinary member cannot');
  assert.equal(sql(`SELECT COUNT(*) n FROM settlements WHERE status='confirmed' AND dormitory_id=?`, dorm)[0].n, 0);
  r = await press(50000, ok.callback_data); assert.match(last(r).text, /تأیید شد/);
  assert.equal(sql(`SELECT COUNT(*) n FROM settlements WHERE status='confirmed' AND from_member_id=? AND amount=2000000`, reza)[0].n, 1);
  r = await say(50010, '/settle'); assert.doesNotMatch(last(r).text, /پرداخت کردم/, 'reza has nothing left to pay');
});

test('bot settle: the creditor is told what happens next; a room without confirmation applies the payment at once', async () => {
  await say(51000, '/start'); await press(51000, 'start:new'); await say(51000, 'اتاق بدون تأیید'); await press(51000, 'rc:0');
  await press(51000, 'mem:ids'); await say(51000, '51010 رضا');
  await press(51010, 'mr:ok:' + sql(`SELECT id FROM member_requests WHERE telegram_user_id=51010 AND status='pending'`)[0].id);
  const owner = sql('SELECT id, dormitory_id FROM members WHERE telegram_user_id=51000')[0];
  const reza = sql('SELECT id FROM members WHERE telegram_user_id=51010')[0].id;
  env.DB.raw.prepare(`INSERT INTO expenses(id,dormitory_id,description,total_amount,payer_id,method,expense_date,created_by) VALUES('sx2',?,'قبض',10000000,?,'equal','2026-10-10',?)`).run(owner.dormitory_id, owner.id, owner.id);
  for (const m of [owner.id, reza]) env.DB.raw.prepare(`INSERT INTO expense_allocations(expense_id,member_id,amount) VALUES('sx2',?,5000000)`).run(m);

  let r = await say(51000, '/settle');
  assert.match(last(r).text, /شما طلبکارید/); assert.equal(last(r).reply_markup, undefined);
  r = await say(51010, '/settle');
  assert.match(last(r).text, /فوراً در ترازها اعمال شود/);
  r = await press(51010, last(r).reply_markup.inline_keyboard[0][0].callback_data);
  assert.match(last(r).text, /مستقیماً در ترازها اعمال شد/);
  assert.equal(sql(`SELECT COUNT(*) n FROM settlements WHERE status='confirmed' AND from_member_id=?`, reza)[0].n, 1);
  r = await say(51000, '/settle'); assert.match(last(r).text, /تسویه است/);
});

test('bot: guest members (عضو مهمان) start unticked unless they pay, the author can tick them, only an admin can set them (even themself)', async () => {
  await say(52000, '/start'); await press(52000, 'start:new'); await say(52000, 'اتاق مهمان'); await press(52000, 'rc:1');
  await say(52000, '/addmember سارا');
  await press(52000, 'mem:ids'); await say(52000, '52010 رضا\n52020 امیر');
  for (const t of [52010, 52020]) await press(t, 'mr:ok:' + sql(`SELECT id FROM member_requests WHERE telegram_user_id=? AND status='pending'`, t)[0].id);
  const dorm = sql('SELECT dormitory_id d FROM members WHERE telegram_user_id=52000')[0].d as string;
  const byTg = (t: number) => sql('SELECT id FROM members WHERE telegram_user_id=?', t)[0].id as string;
  const admin = byTg(52000), reza = byTg(52010), amir = byTg(52020), sara = sql(`SELECT id FROM members WHERE dormitory_id=? AND display_name='سارا'`, dorm)[0].id as string;
  const isSub = (id: string) => sql('SELECT is_substitute s FROM members WHERE id=?', id)[0].s as number;
  const sel = (t: number) => JSON.parse(sql('SELECT state FROM bot_state WHERE telegram_user_id=?', t)[0].state).sel as string[];

  // admin only
  let r = await say(52010, '/guests'); assert.match(last(r).text, /فقط مدیر/);
  r = await press(52010, 'sub:' + amir); assert.match(last(r).text, /فقط مدیر/); assert.equal(isSub(amir), 0);
  r = await say(52000, '/members');
  assert.ok(last(r).reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === 'mem:sub'), 'admin finds it under «اعضا»');
  r = await say(52010, '/members'); assert.equal(last(r).reply_markup, undefined);

  // the admin marks amir AND themself as guests; the message is edited in place
  r = await say(52000, '/guests');
  const rows = last(r).reply_markup.inline_keyboard.flat();
  assert.deepEqual(rows.map((b: any) => b.callback_data).sort(), [admin, reza, amir, sara].map((i) => 'sub:' + i).sort(), 'everyone is listed, including the admin');
  await press(52000, 'sub:' + amir, 77);
  const edit = sent.find((x: any) => x.method === 'editMessageReplyMarkup' && x.message_id === 77);
  assert.ok(edit.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === 'sub:' + amir && /مهمان/.test(b.text)));
  await press(52000, 'sub:' + admin, 77);
  assert.equal(isSub(amir), 1); assert.equal(isSub(admin), 1); assert.equal(isSub(reza), 0);
  await press(52000, 'sub:' + sara, 77); await press(52000, 'sub:' + sara, 77); assert.equal(isSub(sara), 0, 'tapping again switches back');
  assert.equal(sql(`SELECT COUNT(*) n FROM audit_events WHERE action='substitute' AND dormitory_id=?`, dorm)[0].n, 4);
  r = await say(52000, '/members'); assert.match(last(r).text, /امیر — مهمان/);

  // reza records an equal expense: main members ticked, guests unticked and in their own block
  await say(52010, '/add'); await say(52010, '90000'); await say(52010, 'سینما');
  await press(52010, 'p:' + reza);
  r = await press(52010, 'm:eq');
  assert.deepEqual(sel(52010).sort(), [reza, sara].sort());
  const kb = last(r).reply_markup.inline_keyboard;
  const idx = (cb: string) => kb.findIndex((row: any) => row[0].callback_data === cb);
  assert.ok(idx('t:' + reza) < idx('noop') && idx('t:' + sara) < idx('noop'), 'main members first');
  assert.ok(idx('noop') < idx('t:' + amir) && idx('noop') < idx('t:' + admin), 'guest block below its header');
  const txt = (id: string) => kb[idx('t:' + id)][0].text;
  assert.match(txt(reza), /^✅/); assert.match(txt(sara), /^✅/); assert.match(txt(amir), /^⬜/); assert.match(txt(admin), /^⬜/);
  assert.equal((await press(52010, 'noop')).length, 0, 'the header does nothing');
  // the author ticks a guest this time, then goes back to the defaults, then unticks themself
  await press(52010, 't:' + amir, 5); assert.deepEqual(sel(52010).sort(), [reza, sara, amir].sort());
  await press(52010, 't:def', 5); assert.deepEqual(sel(52010).sort(), [reza, sara].sort());
  await press(52010, 't:' + amir, 5); await press(52010, 't:' + reza, 5);
  r = await press(52010, 't:ok'); assert.match(last(r).text, /سارا: ۴۵٬۰۰۰ تومان/); assert.match(last(r).text, /امیر: ۴۵٬۰۰۰ تومان/); assert.doesNotMatch(last(r).text, /رضا: /);
  await press(52010, 'c:ok');
  const saved = sql(`SELECT a.member_id FROM expense_allocations a JOIN expenses e ON e.id=a.expense_id WHERE e.description='سینما' AND e.dormitory_id=?`, dorm).map((x: any) => x.member_id).sort();
  assert.deepEqual(saved, [sara, amir].sort(), 'only the people ticked are charged');

  // "همه" still means everybody; custom split lists mark the guests
  await say(52010, '/add'); await say(52010, '1000'); await say(52010, 'چای'); await press(52010, 'p:' + reza); await press(52010, 'm:eq');
  await press(52010, 't:all', 6); assert.equal(sel(52010).length, 4);
  await say(52010, '/add'); await say(52010, '1000'); await say(52010, 'چای ۲'); await press(52010, 'p:' + reza);
  r = await press(52010, 'm:cu'); assert.match(last(r).text, /امیر \(مهمان\)/); assert.doesNotMatch(last(r).text, /رضا \(مهمان\)/);
  await say(52010, '/cancel');

  // a guest who PAYS starts ticked (the other guest does not); «پیش‌فرض» keeps that; the old command name still works
  await say(52010, '/add'); await say(52010, '1000'); await say(52010, 'بنزین'); await press(52010, 'p:' + amir);
  r = await press(52010, 'm:eq');
  assert.deepEqual(sel(52010).sort(), [reza, sara, amir].sort(), 'guest payer ticked, the other guest not');
  const tick = (id: string) => last(r).reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data === 't:' + id).text;
  assert.match(tick(amir), /^✅/); assert.match(tick(admin), /^⬜/);
  await press(52010, 't:' + amir, 5); assert.deepEqual(sel(52010).sort(), [reza, sara].sort(), 'the author may untick the payer');
  await press(52010, 't:def', 5); assert.deepEqual(sel(52010).sort(), [reza, sara, amir].sort(), 'default = main members + the guest payer');
  await say(52010, '/add'); await say(52010, '1000'); await say(52010, 'قهوه'); await press(52010, 'p:' + admin); await press(52010, 'm:eq');
  assert.deepEqual(sel(52010).sort(), [reza, sara, admin].sort(), 'the guest admin is ticked when the admin pays');
  assert.match(last(await say(52000, '/substitutes')).text, /مهمان/, 'previous command name still accepted');

  // a main member again: back to ticked by default
  await press(52000, 'sub:' + amir, 77); assert.equal(isSub(amir), 0);
  await say(52010, '/add'); await say(52010, '1000'); await say(52010, 'آب'); await press(52010, 'p:' + reza); await press(52010, 'm:eq');
  assert.deepEqual(sel(52010).sort(), [reza, sara, amir].sort());
});
