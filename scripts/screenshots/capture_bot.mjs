// Captures what the REAL bot code sends in a few conversations, for the README screenshots.
// It runs the actual worker (src/index.ts) against an in-memory SQLite database, with a made-up room and invented people,
// and records every message + button the bot would send to Telegram. Output: scripts/screenshots/bot-chats.json
//
//   node --experimental-strip-types --no-warnings scripts/screenshots/capture_bot.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import worker from '../../src/index.ts';
import { equalAllocation, customAllocation } from '../../src/domain/allocation.ts';

// ---- in-memory D1 (same shim the tests use) ----
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for (const f of readdirSync(new URL('../../migrations/', import.meta.url)).sort()) db.exec(readFileSync(new URL('../../migrations/' + f, import.meta.url), 'utf8'));
const mk = (sql, params = []) => ({
  bind: (...a) => mk(sql, a),
  first: async () => db.prepare(sql).get(...params) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...params) }),
  run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
  _run: () => db.prepare(sql).run(...params),
});
const DB = { prepare: (s) => mk(s), batch: async (st) => { db.exec('BEGIN'); try { for (const s of st) s._run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } } };
const sql = (q, ...a) => db.prepare(q).all(...a);

// ---- fake Telegram: records outgoing messages, enforces the 64-byte callback_data limit like the real one ----
let outbox = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  for (const row of body.reply_markup?.inline_keyboard ?? []) for (const b of row) if (b.callback_data !== undefined && Buffer.byteLength(b.callback_data) > 64) throw new Error('callback_data too long: ' + b.callback_data);
  outbox.push({ method: String(url).split('/').pop(), ...body });
  return new Response('{"ok":true}');
};
const env = { DB, BOT_TOKEN: 't', WEBHOOK_SECRET: 's' };
let uid = 0;
const post = (u) => worker.fetch(new Request('http://x/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' }, body: JSON.stringify(u) }), env);
const NAMES = { 10001: 'علی', 10002: 'رضا', 10003: 'امیر', 10004: 'سینا', 10005: 'نیما' };
const say = async (from, text) => { outbox = []; await post({ update_id: ++uid, message: { from: { id: from, first_name: NAMES[from] ?? 'کاربر' }, chat: { id: from, type: 'private' }, text } }); return outbox.filter((o) => o.method === 'sendMessage'); };
const press = async (from, data) => { outbox = []; await post({ update_id: ++uid, callback_query: { id: 'c' + uid, from: { id: from, first_name: NAMES[from] }, message: { chat: { id: from }, message_id: 1 }, data } }); return outbox; };
const byTg = (t) => sql('SELECT id FROM members WHERE telegram_user_id=?', t)[0].id;

// ---- the invented room ----
await say(10001, '/start'); await press(10001, 'start:new'); await say(10001, 'اتاق ۲۱۴'); await press(10001, 'rc:1');
await press(10001, 'mem:ids'); await say(10001, '10002 رضا\n10003 امیر\n10004 سینا\n10005 نیما');
for (const t of [10002, 10003, 10004, 10005]) await press(t, 'mr:ok:' + sql(`SELECT id FROM member_requests WHERE telegram_user_id=? AND status='pending'`, t)[0].id);
await say(10001, '/addmember سارا');
const dorm = sql('SELECT dormitory_id d FROM members WHERE telegram_user_id=10001')[0].d;
const sara = sql(`SELECT id FROM members WHERE dormitory_id=? AND display_name='سارا'`, dorm)[0].id;
db.prepare('UPDATE dormitories SET round_to=? WHERE id=?').run(1000 * 100, dorm);
await press(10001, 'sub:' + byTg(10005)); await press(10001, 'sub:' + sara); // نیما and سارا are guest members
await press(10002, 'sub:' + byTg(10005)); // (ignored: only admins can)

const [ali, reza, amir, sina, nima] = [10001, 10002, 10003, 10004, 10005].map(byTg);
const T = 100;
const raw = [
  ['2026-10-22', 'پیتزا شب جمعه', 480000, reza, [ali, reza, amir, sina]],
  ['2026-10-20', 'قبض برق', 360000, ali, [ali, reza, amir, sina]],
  ['2026-10-18', 'نان، پنیر و لبنیات', 184000, amir, [ali, reza, amir, sina]],
  ['2026-10-15', 'سینما', 600000, nima, [ali, reza, amir, nima]],
  ['2026-10-10', 'اینترنت ماهانه', 440000, reza, [ali, reza, amir, sina]],
  ['2026-10-07', 'خرید خانه', 270000, sina, { [ali]: 90000, [amir]: 120000, [sina]: 60000 }],
];
raw.forEach(([date, desc, toman, payer, split], i) => {
  const total = toman * T, id = 'ex' + i;
  const r = Array.isArray(split) ? equalAllocation(total, split) : customAllocation(total, Object.entries(split).map(([memberId, v]) => ({ memberId, amount: v * T })));
  db.prepare(`INSERT INTO expenses(id,dormitory_id,description,total_amount,payer_id,method,expense_date,created_by) VALUES(?,?,?,?,?,?,?,?)`).run(id, dorm, desc, total, payer, Array.isArray(split) ? 'equal' : 'custom', date, payer);
  for (const a of r.allocations) db.prepare(`INSERT INTO expense_allocations(expense_id,member_id,amount) VALUES(?,?,?)`).run(id, a.memberId, a.amount);
});
db.prepare(`INSERT INTO settlements(id,dormitory_id,from_member_id,to_member_id,amount,settled_on,status,recorded_by,confirmed_by,confirmed_at) VALUES('s1',?,?,?,?,'2026-10-12','confirmed',?,?,'2026-10-12T10:00:00Z')`).run(dorm, amir, reza, 50000 * T, amir, reza);
db.prepare(`INSERT INTO settlements(id,dormitory_id,from_member_id,to_member_id,amount,settled_on,status,recorded_by) VALUES('s2',?,?,?,?,'2026-10-23','pending',?)`).run(dorm, sina, reza, 40000 * T, sina);

// ---- conversations, as a list of chat items. `hl` marks the button the person tapped ----
const toItems = (msgs) => msgs.map((m) => ({ from: 'bot', text: m.text, keyboard: m.reply_markup?.inline_keyboard ?? null }));
const tap = (items, data) => { // highlight the tapped button in the latest keyboard that has it
  for (let i = items.length - 1; i >= 0; i--) for (const row of items[i].keyboard ?? []) for (const b of row) if (b.callback_data === data) { b.hl = true; return; }
};
const out = {};

// 1) a debtor opens «تسویه حساب» in the bot and records "I paid"
{
  const items = [{ from: 'user', text: 'تسویه حساب' }];
  items.push(...toItems(await say(10003, 'تسویه حساب')));
  const pay = items.at(-1).keyboard.flat().find((b) => b.callback_data.startsWith('pay:'));
  tap(items, pay.callback_data);
  const r = await press(10003, pay.callback_data);
  items.push(...toItems(r.filter((o) => o.method === 'sendMessage' && o.chat_id === 10003)));
  out.settle_debtor = items;
  // 2) the creditor gets a message with buttons and confirms
  const note = r.find((o) => o.method === 'sendMessage' && o.chat_id === 10005);
  const items2 = toItems([note]);
  const ok = note.reply_markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('sc:ok:'));
  tap(items2, ok.callback_data);
  items2.push(...toItems((await press(10005, ok.callback_data)).filter((o) => o.method === 'sendMessage' && o.chat_id === 10005)));
  out.settle_creditor = items2;
}

// 3) adding an expense in the bot: main members ticked, guests in their own block, unticked
{
  const items = [{ from: 'user', text: 'ثبت هزینه' }];
  items.push(...toItems(await say(10001, 'ثبت هزینه')));
  items.push({ from: 'user', text: '۱۲۰٬۰۰۰' }); await say(10001, '۱۲۰٬۰۰۰');
  items.push({ from: 'user', text: 'میوه و سبزی' }); const payerMsg = await say(10001, 'میوه و سبزی');
  await press(10001, 'p:' + ali);
  const parts = (await press(10001, 'm:eq')).filter((o) => o.method === 'sendMessage');
  items.length = 0; // keep the chat short: start the screenshot at the "who shares?" step
  items.push(...toItems(parts));
  out.add_expense = items;
}

// 4) the admin chooses guest members
{
  const items = [{ from: 'user', text: '/guests' }];
  items.push(...toItems(await say(10001, '/guests')));
  out.guests = items;
}
// 5) /members shows the guests too
{
  const items = [{ from: 'user', text: 'اعضا' }];
  items.push(...toItems(await say(10001, 'اعضا')));
  out.members = items;
}

writeFileSync(new URL('./bot-chats.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('chats:', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length + ' items'])));
