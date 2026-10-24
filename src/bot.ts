import { tg } from './tg.ts';
import { parseAmount, normalizeDigits, formatToman } from './domain/money.ts';
import { equalAllocation, customAllocation } from './domain/allocation.ts';
import type { Allocation } from './domain/allocation.ts';
import { computeBalances } from './domain/ledger.ts';
import type { LedgerExpense, LedgerSettlement } from './domain/ledger.ts';
import { proposeTransfers, roundBalances } from './domain/settlement.ts';
import { runBackup } from './backup.ts';

type Env = any;
const q1 = (env: Env, sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first();
const qa = async (env: Env, sql: string, ...a: unknown[]): Promise<any[]> => (await env.DB.prepare(sql).bind(...a).all()).results;
const ex = (env: Env, sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const st = (env: Env, sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a);
const uuid = () => crypto.randomUUID();
const faNum = (n: number) => new Intl.NumberFormat('fa-IR').format(n); // Persian digits, like the amounts
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
export const fa = (iso: string) => new Date(iso + 'T12:00:00Z').toLocaleDateString('fa-IR-u-ca-persian', { timeZone: 'UTC' });

const LABELS: Record<string, string> = { 'ثبت هزینه': 'add', 'تراز': 'balance', 'تسویه حساب': 'settle', 'هزینه‌ها': 'expenses', 'اعضا': 'members', 'اتاق‌ها': 'rooms', 'راهنما': 'help', 'انصراف': 'cancel', '🚀 باز کردن DormLedger': 'openapp' };
const REPLY_KB = { keyboard: [[{ text: 'ثبت هزینه' }, { text: 'تراز' }], [{ text: 'تسویه حساب' }, { text: 'هزینه‌ها' }], [{ text: 'اعضا' }, { text: 'اتاق‌ها' }, { text: 'راهنما' }]], resize_keyboard: true, is_persistent: true };
async function send(env: Env, chat: number, text: string, kb?: any) {
  let reply_markup: any;
  if (kb === MENU) {
    // Web App reply-keyboard buttons are supported in private chats only. Keep all legacy shortcuts.
    // NOTE: a web_app button on a reply keyboard opens the Mini App WITHOUT initData (Telegram limitation),
    // so the app could not authenticate. This is a plain text button; the bot answers with an inline web_app button.
    const keyboard: any[][] = [];
    if (chat > 0) keyboard.push([{ text: '🚀 باز کردن DormLedger' }]);
    keyboard.push(...REPLY_KB.keyboard);
    reply_markup = { ...REPLY_KB, keyboard };
  } else reply_markup = Array.isArray(kb) ? { inline_keyboard: kb } : kb ?? undefined; // non-array object = raw reply_markup
  await tg(env, 'sendMessage', { chat_id: chat, text, ...(reply_markup ? { reply_markup } : {}) });
}
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

const HELP = `دستورها:
/add ثبت هزینه
/balance تراز من و گروه
/settle پیشنهاد تسویه
/expenses هزینه‌های اخیر
/members اعضا
/guests اعضای مهمان (مدیر): کسانی که در هزینه‌ها پیش‌فرض تیک ندارند، مگر خودشان پرداخت کنند
/rooms اتاق‌ها (چند اتاق، حذف اتاق)
/addmember نام — افزودن عضو (مدیر)
/invite [شماره‌ی عضو] — ساخت کد دعوت (مدیر)
/join کد — پیوستن با کد دعوت
/app باز کردن برنامه
/clearhistory پاک کردن کل تاریخچه (۴۸ ساعت قابل بازگردانی)
/restorehistory بازگردانی تاریخچه‌ی پاک‌شده
/name نام — تغییر نام من
/nickname نام — نام مستعار من (حذف: /nickname -)
/leave ترک اتاق فعلی (وقتی تراز شما صفر است)
/cancel لغو عملیات جاری`;
const MENU: any[][] = []; // sentinel: send() swaps in the persistent bottom keyboard

const MEMBERSHIP = `SELECT m.*, d.name AS dname, d.require_confirm AS rc, d.round_to AS rt FROM members m JOIN dormitories d ON d.id=m.dormitory_id WHERE m.telegram_user_id=? AND m.active=1 AND d.deleted_at IS NULL`;
/** The member row for the user's *current* room (falls back to their first room). */
export async function me(env: Env, uid: number) {
  const pref = await q1(env, 'SELECT dormitory_id FROM user_prefs WHERE telegram_user_id=?', uid);
  if (pref?.dormitory_id) { const r = await q1(env, MEMBERSHIP + ' AND m.dormitory_id=?', uid, pref.dormitory_id); if (r) return r; }
  return q1(env, MEMBERSHIP + ' ORDER BY m.rowid LIMIT 1', uid);
}
export const myRooms = (env: Env, uid: number) => qa(env, `SELECT m.id AS member_id, m.dormitory_id AS id, m.role, d.name FROM members m JOIN dormitories d ON d.id=m.dormitory_id WHERE m.telegram_user_id=? AND m.active=1 AND d.deleted_at IS NULL ORDER BY m.rowid`, uid);
const setPref = (env: Env, uid: number, dorm: string) => ex(env, `INSERT INTO user_prefs(telegram_user_id,dormitory_id) VALUES(?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET dormitory_id=excluded.dormitory_id`, uid, dorm);
export async function switchRoom(env: Env, uid: number, dorm: string): Promise<boolean> {
  if (!(await myRooms(env, uid)).some((r) => r.id === dorm)) return false;
  await setPref(env, uid, dorm); return true;
}
export async function deleteRoom(env: Env, uid: number, dorm: string, typedName?: string): Promise<{ ok: boolean; error?: string }> {
  const r = (await myRooms(env, uid)).find((x) => x.id === dorm);
  if (!r) return { ok: false, error: 'اتاق پیدا نشد' };
  if (r.role !== 'owner') return { ok: false, error: 'فقط مدیر اصلی می‌تواند اتاق را حذف کند' };
  if (typedName !== undefined && typedName.trim() !== r.name) return { ok: false, error: 'نام اتاق را دقیقاً مثل خودش بنویسید' };
  await env.DB.batch([
    st(env, `UPDATE dormitories SET deleted_at=? WHERE id=? AND deleted_at IS NULL`, new Date().toISOString(), dorm),
    st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action) VALUES(?,?,?,?,?)`, dorm, r.member_id, 'dormitory', dorm, 'delete'),
  ]);
  const next = (await myRooms(env, uid))[0];
  if (next) await setPref(env, uid, next.id); else await ex(env, 'DELETE FROM user_prefs WHERE telegram_user_id=?', uid);
  return { ok: true };
}
export async function leaveRoom(env: Env, uid: number): Promise<{ ok: true; room: string } | { ok: false; error: string }> {
  const m = await me(env, uid);
  if (!m) return { ok: false, error: 'عضو هیچ اتاقی نیستید.' };
  if (m.role === 'owner') return { ok: false, error: 'مدیر اصلی نمی‌تواند اتاق را ترک کند. اتاق را حذف کنید.' };
  const { eff } = await ledger(env, m.dormitory_id);
  if ((eff.get(m.id) ?? 0) !== 0) return { ok: false, error: 'ترازتان هنوز صفر نیست؛ اول تسویه کنید.' };
  const pend = await q1(env, `SELECT COUNT(*) AS n FROM settlements WHERE dormitory_id=? AND status='pending' AND (from_member_id=? OR to_member_id=?)`, m.dormitory_id, m.id, m.id);
  if (pend.n) return { ok: false, error: 'یک پرداخت در انتظار تأیید دارید؛ اول آن را نهایی یا لغو کنید.' };
  await env.DB.batch([
    st(env, `UPDATE members SET active=0 WHERE id=? AND active=1`, m.id),
    st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action) VALUES(?,?,?,?,?)`, m.dormitory_id, m.id, 'member', m.id, 'leave'),
  ]);
  const next = (await myRooms(env, uid))[0];
  if (next) await setPref(env, uid, next.id); else await ex(env, 'DELETE FROM user_prefs WHERE telegram_user_id=?', uid);
  for (const a of await qa(env, `SELECT id FROM members WHERE dormitory_id=? AND active=1 AND role IN ('owner','admin') AND telegram_user_id IS NOT NULL`, m.dormitory_id)) await notifyUser(env, a.id, `${m.display_name} از اتاق «${m.dname}» خارج شد.`);
  return { ok: true, room: m.dname };
}
export const activeMembers = (env: Env, dorm: string) => qa(env, `SELECT id, display_name, nickname, telegram_user_id, role, is_substitute FROM members WHERE dormitory_id=? AND active=1 ORDER BY rowid`, dorm);
export const isAdmin = (m: any) => m.role === 'owner' || m.role === 'admin';
/**
 * The members that start ticked in a new expense: every main member, plus a guest member ("عضو مهمان", DB column
 * `is_substitute`) only when that guest is the payer. The author can change any tick afterwards.
 */
export const defaultParticipants = (ms: any[], payerId?: string): string[] => ms.filter((x) => !x.is_substitute || x.id === payerId).map((x) => x.id);
/**
 * Marks a member as a guest ("عضو مهمان": not ticked by default in new expenses unless they pay) or back to a main member.
 * Admin / owner only; the target may be anyone in the room, including the admin themself. `substitute` undefined = toggle.
 */
export async function setSubstitute(env: Env, m: any, targetId: string, substitute?: boolean): Promise<{ ok: true; substitute: boolean; name: string } | { ok: false; error: string; notFound?: boolean }> {
  if (!isAdmin(m)) return { ok: false, error: 'فقط مدیر می‌تواند اعضای مهمان را مشخص کند.' };
  const t = await q1(env, 'SELECT id, display_name, is_substitute FROM members WHERE id=? AND dormitory_id=? AND active=1', targetId, m.dormitory_id);
  if (!t) return { ok: false, error: 'عضو پیدا نشد.', notFound: true };
  const next = substitute === undefined ? !t.is_substitute : substitute;
  if (!!t.is_substitute !== next) {
    await env.DB.batch([
      st(env, 'UPDATE members SET is_substitute=? WHERE id=?', next ? 1 : 0, t.id),
      st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,before_json,after_json) VALUES(?,?,?,?,?,?,?)`, m.dormitory_id, m.id, 'member', t.id, 'substitute', JSON.stringify({ substitute: !!t.is_substitute }), JSON.stringify({ substitute: next })),
    ]);
  }
  return { ok: true, substitute: next, name: t.display_name };
}
const getState = async (env: Env, uid: number) => { const r = await q1(env, 'SELECT state FROM bot_state WHERE telegram_user_id=?', uid); return r ? JSON.parse(r.state) : null; };
const setState = (env: Env, uid: number, s: any) => ex(env, `INSERT INTO bot_state(telegram_user_id,state) VALUES(?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET state=excluded.state, updated_at=datetime('now')`, uid, JSON.stringify(s));
const clearState = (env: Env, uid: number) => ex(env, 'DELETE FROM bot_state WHERE telegram_user_id=?', uid);

export async function ledger(env: Env, dorm: string) {
  const members = await qa(env, 'SELECT id, display_name FROM members WHERE dormitory_id=? ORDER BY rowid', dorm);
  const exps = await qa(env, `SELECT id,total_amount,payer_id FROM expenses WHERE dormitory_id=? AND status='active'`, dorm);
  const als = await qa(env, `SELECT a.expense_id,a.member_id,a.amount FROM expense_allocations a JOIN expenses e ON e.id=a.expense_id WHERE e.dormitory_id=? AND e.status='active'`, dorm);
  const sets = await qa(env, `SELECT id,from_member_id,to_member_id,amount FROM settlements WHERE dormitory_id=? AND status='confirmed'`, dorm);
  const byE = new Map<string, Allocation[]>();
  for (const a of als) { if (!byE.has(a.expense_id)) byE.set(a.expense_id, []); byE.get(a.expense_id)!.push({ memberId: a.member_id, amount: a.amount }); }
  const le: LedgerExpense[] = exps.map((e) => ({ id: e.id, total: e.total_amount, payerId: e.payer_id, allocations: byE.get(e.id) ?? [], status: 'active' }));
  const ls: LedgerSettlement[] = sets.map((s) => ({ id: s.id, fromId: s.from_member_id, toId: s.to_member_id, amount: s.amount, status: 'confirmed' }));
  const net = computeBalances(members.map((m) => m.id), le, ls);
  const names = new Map<string, string>(members.map((m) => [m.id, m.display_name]));
  // Optional room setting: round the suggested payments to a whole unit (e.g. 1000 toman). Real balances stay exact.
  const unit = Number((await q1(env, 'SELECT round_to FROM dormitories WHERE id=?', dorm))?.round_to ?? 0);
  const eff = unit > 1 ? roundBalances(net, unit) : net; // eff = balances as the plan sees them; "settled" means eff == 0
  return { net, eff, unit, names, plan: proposeTransfers(eff) };
}

// ---------- commands ----------
async function cmdBalance(env: Env, chat: number, m: any) {
  const { net, names, plan } = await ledger(env, m.dormitory_id);
  const mine = net.get(m.id) ?? 0;
  let t = `خوابگاه «${m.dname}»\n\n`;
  t += mine > 0 ? `تراز شما: ${formatToman(mine)} طلبکار هستید` : mine < 0 ? `تراز شما: ${formatToman(-mine)} بدهکار هستید` : 'تراز شما صفر است (تسویه‌اید)';
  t += '\n\nتراز اعضا:\n';
  for (const [id, v] of net) t += `• ${names.get(id)}: ${v > 0 ? 'طلبکار ' : v < 0 ? 'بدهکار ' : 'تسویه '}${v === 0 ? '' : formatToman(Math.abs(v))}\n`;
  await send(env, chat, t, [[{ text: 'پیشنهاد تسویه', callback_data: 'menu:settle' }]]);
}
async function cmdSettle(env: Env, chat: number, m: any) {
  const { names, plan, unit } = await ledger(env, m.dormitory_id);
  const pend = await qa(env, `SELECT id, from_member_id, to_member_id, amount FROM settlements WHERE dormitory_id=? AND status='pending' ORDER BY rowid`, m.dormitory_id);
  if (!plan.length && !pend.length) return send(env, chat, 'همه‌چیز تسویه است. بدهی‌ای وجود ندارد.');
  // Same rule as the Mini App: the recipient answers; an admin may answer for a recipient who is not connected to Telegram.
  const linked = new Map<string, boolean>((await qa(env, 'SELECT id, telegram_user_id FROM members WHERE dormitory_id=?', m.dormitory_id)).map((r) => [r.id, !!r.telegram_user_id]));
  const kb: any[][] = [];
  let t = '';
  if (plan.length) {
    t += 'پیشنهاد تسویه:\n' + plan.map((p) => `• ${names.get(p.fromId)} باید ${formatToman(p.amount)} به ${names.get(p.toId)} پرداخت کند.`).join('\n');
    // callback_data is limited to 64 bytes by Telegram: two UUIDs do not fit. The payer is always the person tapping, so only the recipient is sent.
    for (const p of plan) if (p.fromId === m.id) kb.push([{ text: `پرداخت کردم: ${formatToman(p.amount)} به ${names.get(p.toId)}`, callback_data: `pay:${p.toId}:${p.amount}` }]);
    if (unit > 1) t += `\n(مبالغ به نزدیک‌ترین ${formatToman(unit)} گرد شده‌اند.)`;
    const owes = plan.some((p) => p.fromId === m.id), owed = plan.some((p) => p.toId === m.id);
    t += '\n\n' + (owes
      ? m.rc === 0
        ? 'بعد از اینکه پول را واقعاً پرداخت کردید، دکمه‌ی «پرداخت کردم» را بزنید تا فوراً در ترازها اعمال شود.'
        : 'بعد از اینکه پول را واقعاً پرداخت کردید، دکمه‌ی «پرداخت کردم» را بزنید تا برای تأیید به طلب‌کار برود.'
      : owed ? 'شما طلبکارید. هر وقت بدهکار پرداختش را ثبت کند، برای تأیید به شما پیام می‌آید.'
      : 'شما در این پیشنهاد بدهی یا طلبی ندارید. فقط خودِ بدهکار می‌تواند پرداخت خودش را ثبت کند.');
  }
  if (pend.length) {
    t += '\n\nمنتظر تأیید:\n' + pend.map((x) => `• ${names.get(x.from_member_id)} ← ${names.get(x.to_member_id)}: ${formatToman(x.amount)}`).join('\n');
    for (const x of pend) {
      const canAnswer = x.to_member_id === m.id || (isAdmin(m) && !linked.get(x.to_member_id));
      if (canAnswer) kb.push([{ text: `تأیید دریافت از ${names.get(x.from_member_id)}`, callback_data: 'sc:ok:' + x.id }, { text: 'رد', callback_data: 'sc:no:' + x.id }]);
      if (x.from_member_id === m.id) kb.push([{ text: `لغو پرداخت به ${names.get(x.to_member_id)}`, callback_data: 'sc:x:' + x.id }]);
    }
  }
  await send(env, chat, t, kb.length ? kb : undefined);
}
async function cmdExpenses(env: Env, chat: number, m: any) {
  const rows = await qa(env, `SELECT e.description, e.total_amount, e.expense_date, p.display_name AS payer FROM expenses e JOIN members p ON p.id=e.payer_id WHERE e.dormitory_id=? AND e.status='active' ORDER BY e.expense_date DESC, e.rowid DESC LIMIT 10`, m.dormitory_id);
  if (!rows.length) return send(env, chat, 'هنوز هزینه‌ای ثبت نشده است.', [[{ text: 'ثبت هزینه', callback_data: 'menu:add' }]]);
  await send(env, chat, 'هزینه‌های اخیر:\n' + rows.map((r) => `• ${fa(r.expense_date)} — ${r.description} — ${formatToman(r.total_amount)} (پرداخت: ${r.payer})`).join('\n'));
}
async function cmdMembers(env: Env, chat: number, m: any) {
  const ms = await activeMembers(env, m.dormitory_id);
  const LRM = '\u200e'; // forces each line left-to-right so the list aligns consistently
  await send(env, chat, LRM + 'اعضا:\n' + ms.map((x, i) => `${LRM}${i + 1}. ${x.display_name}${x.nickname ? ` — مستعار: ${x.nickname}` : ''}${x.role === 'owner' ? ' (مدیر)' : ''}${x.is_substitute ? ' — مهمان' : ''}${x.telegram_user_id ? '' : ' — هنوز به تلگرام وصل نشده'}`).join('\n'),
    isAdmin(m) ? [[{ text: 'افزودن با آیدی تلگرام', callback_data: 'mem:ids' }], [{ text: 'افزودن بدون تلگرام', callback_data: 'mem:add' }, { text: 'ساخت کد دعوت', callback_data: 'mem:inv' }], [{ text: 'اعضای مهمان', callback_data: 'mem:sub' }]] : undefined);
}
const subKb = (ms: any[]) => ms.map((x) => [{ text: `${x.is_substitute ? '🔁 مهمان' : '✅ اصلی'} — ${x.display_name}`, callback_data: 'sub:' + x.id }]);
const SUB_TEXT = 'اعضای اصلی و مهمان\n\n✅ اصلی: هنگام ثبت هزینه همیشه تیک‌خورده است (ثبت‌کننده می‌تواند تیکش را بردارد).\n🔁 مهمان: هنگام ثبت هزینه تیک ندارد، مگر اینکه خودش پرداخت‌کننده باشد؛ آن‌وقت تیکش خورده است. ثبت‌کننده می‌تواند هر تیکی را عوض کند.\n\nروی اسم هر نفر بزنید تا بین «اصلی» و «مهمان» عوض شود (خودتان هم می‌توانید).';
async function cmdSubstitutes(env: Env, chat: number, m: any) {
  if (!isAdmin(m)) return send(env, chat, 'فقط مدیر می‌تواند اعضای مهمان را مشخص کند.');
  await send(env, chat, SUB_TEXT, subKb(await activeMembers(env, m.dormitory_id)));
}
async function cmdAddMember(env: Env, chat: number, m: any, arg: string) {
  if (!isAdmin(m)) return send(env, chat, 'فقط مدیر می‌تواند عضو اضافه کند.');
  const name = arg.trim();
  if (name.length < 1 || name.length > 60) return send(env, chat, 'نام را بعد از دستور بنویسید. مثال: /addmember رضا');
  const id = uuid();
  await env.DB.batch([
    st(env, `INSERT INTO members(id,dormitory_id,display_name) VALUES(?,?,?)`, id, m.dormitory_id, name),
    st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`, m.dormitory_id, m.id, 'member', id, 'create', JSON.stringify({ name })),
  ]);
  await send(env, chat, `«${name}» اضافه شد.`, [[{ text: 'ساخت کد دعوت برای او', callback_data: 'inv:' + id }, { text: 'افزودن عضو دیگر', callback_data: 'mem:add' }]]);
}
async function cmdInvite(env: Env, chat: number, m: any, arg: string) {
  if (!isAdmin(m)) return send(env, chat, 'فقط مدیر می‌تواند دعوت بسازد.');
  let memberId: string | null = null;
  const n = parseInt(normalizeDigits(arg.trim()) || '0', 10);
  if (n > 0) {
    const ms = await activeMembers(env, m.dormitory_id);
    const target = ms[n - 1];
    if (!target) return send(env, chat, 'شماره‌ی عضو نامعتبر است.');
    if (target.telegram_user_id) return send(env, chat, 'این عضو قبلاً به تلگرام وصل شده است.');
    memberId = target.id;
  }
  return makeInvite(env, chat, m, memberId);
}
export async function createInviteCode(env: Env, m: any, memberId: string | null): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  await ex(env, `INSERT INTO invitations(id,dormitory_id,member_id,token_hash,expires_at,created_by) VALUES(?,?,?,?,?,?)`,
    uuid(), m.dormitory_id, memberId, await sha(code), new Date(Date.now() + 7 * 864e5).toISOString(), m.id);
  return code;
}
async function makeInvite(env: Env, chat: number, m: any, memberId: string | null) {
  const code = await createInviteCode(env, m, memberId);
  await send(env, chat, `کد دعوت (یک‌بار مصرف، ۷ روز اعتبار):\n${code}\n\nدوستتان باید در همین ربات بنویسد:\n/join ${code}`);
}
export async function joinWithCode(env: Env, uid: number, from: any, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = code.trim().toUpperCase();
  const inv = c ? await q1(env, `SELECT i.* FROM invitations i JOIN dormitories d ON d.id=i.dormitory_id WHERE i.token_hash=? AND i.used_at IS NULL AND i.expires_at > ? AND d.deleted_at IS NULL`, await sha(c), new Date().toISOString()) : null;
  if (!inv) return { ok: false, error: 'کد دعوت نامعتبر یا منقضی است.' };
  if (await q1(env, `SELECT 1 FROM members WHERE dormitory_id=? AND telegram_user_id=? AND active=1`, inv.dormitory_id, uid)) return { ok: false, error: 'شما قبلاً عضو این اتاق هستید.' };
  const stmts = [];
  if (inv.member_id) stmts.push(st(env, `UPDATE members SET telegram_user_id=? WHERE id=? AND telegram_user_id IS NULL`, uid, inv.member_id));
  else stmts.push(st(env, `INSERT INTO members(id,dormitory_id,display_name,telegram_user_id) VALUES(?,?,?,?)`, uuid(), inv.dormitory_id, [from?.first_name, from?.last_name].filter(Boolean).join(' ').slice(0, 60) || 'عضو', uid));
  stmts.push(st(env, `UPDATE invitations SET used_at=? WHERE id=?`, new Date().toISOString(), inv.id));
  await env.DB.batch(stmts);
  if (!(await switchRoom(env, uid, inv.dormitory_id))) return { ok: false, error: 'پیوستن انجام نشد.' };
  return { ok: true };
}
async function cmdJoin(env: Env, chat: number, uid: number, from: any, code: string) {
  const r = await joinWithCode(env, uid, from, code);
  if (!r.ok) return send(env, chat, r.error);
  const m = await me(env, uid);
  await send(env, chat, `به خوابگاه «${m.dname}» پیوستید.`, MENU);
  await askName(env, chat, uid, m);
}
async function askName(env: Env, chat: number, uid: number, m: any) {
  await setState(env, uid, { step: 'pname' });
  await send(env, chat, `نام شما در این خوابگاه «${m.display_name}» ثبت شده است.\nاگر می‌خواهید نام دیگری نمایش داده شود، همین الان بنویسید؛ وگرنه دکمه‌ی زیر را بزنید.`, [[{ text: 'همین نام درست است', callback_data: 'pf:keep' }]]);
}
async function askNick(env: Env, chat: number, uid: number) {
  await setState(env, uid, { step: 'pnick' });
  await send(env, chat, 'یک نام مستعار هم می‌خواهید؟ (اختیاری؛ اسمی که دوستانتان صدایتان می‌زنند). آن را بنویسید یا رد کنید.', [[{ text: 'نام مستعار ندارم', callback_data: 'pf:skip' }]]);
}
async function finishProfile(env: Env, chat: number, uid: number) {
  await clearState(env, uid);
  await send(env, chat, 'ذخیره شد. هر وقت خواستید با /name و /nickname تغییرش دهید.', MENU);
  await openAppButton(env, chat);
}
async function cmdProfile(env: Env, chat: number, m: any, field: string, arg: string) {
  const v = arg.trim();
  if (field === 'name') {
    if (!v) return send(env, chat, 'نام جدید را کنار دستور بنویسید. مثال: /name علی');
    if (v.length > 60) return send(env, chat, 'نام باید حداکثر ۶۰ نویسه باشد.');
    await ex(env, 'UPDATE members SET display_name=? WHERE id=?', v, m.id);
    return send(env, chat, `نام شما «${v}» شد.`);
  }
  if (!v) return send(env, chat, 'نام مستعار را کنار دستور بنویسید. مثال: /nickname ابوعلی\nبرای حذف: /nickname -');
  if (v === '-') { await ex(env, 'UPDATE members SET nickname=NULL WHERE id=?', m.id); return send(env, chat, 'نام مستعار حذف شد.'); }
  if (v.length > 30) return send(env, chat, 'نام مستعار باید حداکثر ۳۰ نویسه باشد.');
  await ex(env, 'UPDATE members SET nickname=? WHERE id=?', v, m.id);
  return send(env, chat, `نام مستعار شما «${v}» شد.`);
}
export async function createDormitory(env: Env, uid: number, from: any, name: string, requireConfirm = true) {
  const dId = uuid(), mId = uuid();
  await env.DB.batch([
    st(env, `INSERT INTO dormitories(id,name,require_confirm) VALUES(?,?,?)`, dId, name, requireConfirm ? 1 : 0),
    st(env, `INSERT INTO members(id,dormitory_id,display_name,telegram_user_id,role) VALUES(?,?,?,?,'owner')`, mId, dId, [from?.first_name, from?.last_name].filter(Boolean).join(' ').slice(0, 60) || 'مدیر', uid),
    st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action) VALUES(?,?,?,?,?)`, dId, mId, 'dormitory', dId, 'create'),
    st(env, `DELETE FROM bot_state WHERE telegram_user_id=?`, uid),
    st(env, `INSERT INTO user_prefs(telegram_user_id,dormitory_id) VALUES(?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET dormitory_id=excluded.dormitory_id`, uid, dId),
  ]);
}
async function openAppButton(env: Env, chat: number) {
  if (!env.APP_URL) return;
  await send(env, chat, 'برنامه‌ی کامل با نمودار و گزارش:', [[{ text: 'باز کردن برنامه', web_app: { url: env.APP_URL } } as any]]);
}


// ---------- add members by Telegram ID ----------
export function parseIdEntries(text: string): { id: number; name: string }[] {
  const out: { id: number; name: string }[] = [];
  const re = /(\d{5,15})(?:[ \t]*[:,\-]?[ \t]*([^\d\n,;]+))?/g;
  let mt: RegExpExecArray | null;
  const t = normalizeDigits(text.replace(/\s+/g, (x) => (x.includes('\n') ? '\n' : ' ')).replace(/[٬،]/g, ',')).replace(/,/g, ' ');
  while ((mt = re.exec(t))) out.push({ id: Number(mt[1]), name: (mt[2] ?? '').trim().slice(0, 60) });
  return out;
}
export type AddResult = { requested: string[]; undelivered: string[]; skipped: string[] };
/** Sends the invitee a consent prompt. Returns false when Telegram refuses (e.g. they never opened the bot). */
async function sendJoinRequest(env: Env, tgId: number, reqId: string, room: string, inviter: string): Promise<boolean> {
  try {
    const r = await tg(env, 'sendMessage', { chat_id: tgId, text: `${inviter} شما را به اتاق «${room}» در DormLedger دعوت کرده است.\nمی‌خواهید عضو شوید؟ (تا ۷ روز اعتبار دارد)`, reply_markup: { inline_keyboard: [[{ text: '✅ قبول می‌کنم', callback_data: 'mr:ok:' + reqId }, { text: 'رد', callback_data: 'mr:no:' + reqId }]] } });
    return r.ok;
  } catch { return false; }
}
/** Admin adds people by Telegram ID: nobody becomes a member until THEY accept the request. */
export async function addMembersByIds(env: Env, m: any, entries: { id: number; name?: string }[]): Promise<AddResult> {
  const requested: string[] = [], undelivered: string[] = [], skipped: string[] = [];
  const seen = new Set<number>();
  for (const e of entries) {
    if (!Number.isSafeInteger(e.id) || e.id <= 0 || seen.has(e.id)) { skipped.push(String(e.id)); continue; }
    seen.add(e.id);
    if (await q1(env, `SELECT 1 FROM members WHERE dormitory_id=? AND telegram_user_id=? AND active=1`, m.dormitory_id, e.id)) { skipped.push(String(e.id)); continue; }
    const name = (e.name || '').trim().slice(0, 60), id = uuid();
    await env.DB.batch([
      st(env, `UPDATE member_requests SET status='cancelled' WHERE dormitory_id=? AND telegram_user_id=? AND status='pending'`, m.dormitory_id, e.id),
      st(env, `INSERT INTO member_requests(id,dormitory_id,telegram_user_id,name,created_by,expires_at) VALUES(?,?,?,?,?,?)`, id, m.dormitory_id, e.id, name, m.id, new Date(Date.now() + 7 * 864e5).toISOString()),
      st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`, m.dormitory_id, m.id, 'member_request', id, 'create', JSON.stringify({ telegram: e.id })),
    ]);
    ((await sendJoinRequest(env, e.id, id, m.dname, m.display_name)) ? requested : undelivered).push(name || 'عضو جدید');
  }
  return { requested, undelivered, skipped };
}
/** The invitee's answer. Works for people who are not members of anything yet. */
export async function respondMemberRequest(env: Env, uid: number, from: any, id: string, action: 'ok' | 'no'): Promise<{ ok: boolean; message: string }> {
  const r = await q1(env, `SELECT r.*, d.name AS dname, d.deleted_at AS ddel FROM member_requests r JOIN dormitories d ON d.id=r.dormitory_id WHERE r.id=?`, id);
  if (!r || r.telegram_user_id !== uid) return { ok: false, message: 'این دعوت پیدا نشد.' };
  const stale = { ok: false, message: 'این دعوت دیگر معتبر نیست.' };
  if (r.status !== 'pending' || r.ddel || r.expires_at <= new Date().toISOString()) return stale;
  const claim = await env.DB.prepare(`UPDATE member_requests SET status=? WHERE id=? AND status='pending'`).bind(action === 'ok' ? 'accepted' : 'declined', id).run();
  if (!claim.meta?.changes) return stale;
  const who = r.name || [from?.first_name, from?.last_name].filter(Boolean).join(' ').slice(0, 60) || 'عضو جدید';
  if (action === 'no') {
    await notifyUser(env, r.created_by, `${who} دعوت به اتاق «${r.dname}» را رد کرد.`);
    return { ok: true, message: 'دعوت رد شد.' };
  }
  if (await q1(env, `SELECT 1 FROM members WHERE dormitory_id=? AND telegram_user_id=? AND active=1`, r.dormitory_id, uid)) return { ok: true, message: `شما قبلاً عضو اتاق «${r.dname}» هستید.` };
  const mid = uuid();
  await env.DB.batch([
    st(env, `INSERT INTO members(id,dormitory_id,display_name,telegram_user_id) VALUES(?,?,?,?)`, mid, r.dormitory_id, who, uid),
    st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`, r.dormitory_id, mid, 'member', mid, 'join_accepted', JSON.stringify({ request: id })),
  ]);
  await setPref(env, uid, r.dormitory_id);
  await notifyUser(env, r.created_by, `${who} دعوت به اتاق «${r.dname}» را پذیرفت و عضو شد.`);
  return { ok: true, message: `به اتاق «${r.dname}» پیوستید.` };
}
/** Re-sends still-valid requests, so someone who opened the bot only after being invited sees them. */
async function offerPendingRequests(env: Env, chat: number, uid: number) {
  const rows = await qa(env, `SELECT r.id, d.name AS dname, mm.display_name AS inviter FROM member_requests r JOIN dormitories d ON d.id=r.dormitory_id AND d.deleted_at IS NULL JOIN members mm ON mm.id=r.created_by WHERE r.telegram_user_id=? AND r.status='pending' AND r.expires_at > ? ORDER BY r.created_at`, uid, new Date().toISOString());
  for (const r of rows) await sendJoinRequest(env, chat, r.id, r.dname, r.inviter);
}
export async function purgeOldRequests(env: Env): Promise<void> {
  await ex(env, `DELETE FROM member_requests WHERE created_at < datetime('now','-30 day')`);
}
const addedText = (r: AddResult) => {
  const t: string[] = [];
  if (r.requested.length) t.push(`درخواست عضویت برای ${r.requested.join('، ')} فرستاده شد. بعد از «قبول» خودشان عضو می‌شوند.`);
  if (r.undelivered.length) t.push(`پیام به ${r.undelivered.join('، ')} نرسید؛ باید یک بار ربات را /start کنند، بعد دعوت را می‌بینند. (یا برایشان کد دعوت بسازید.)`);
  if (!t.length) t.push('کسی اضافه نشد.');
  if (r.skipped.length) t.push(`ردشده (تکراری یا نامعتبر): ${r.skipped.join('، ')}`);
  return t.join('\n');
};
function sharedEntries(msg: any): { id: number; name: string }[] {
  const out: { id: number; name: string }[] = [];
  const nm = (u: any) => [u?.first_name, u?.last_name].filter(Boolean).join(' ');
  for (const u of msg.users_shared?.users ?? []) out.push({ id: u.user_id, name: nm(u) });
  if (!out.length) for (const id of msg.users_shared?.user_ids ?? []) out.push({ id, name: '' });
  if (msg.user_shared?.user_id) out.push({ id: msg.user_shared.user_id, name: '' });
  return out;
}
function forwardedEntries(msg: any): { id: number; name: string }[] {
  const u = msg.forward_origin?.sender_user ?? msg.forward_from;
  if (u?.id) return [{ id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') }];
  if (msg.contact?.user_id) return [{ id: msg.contact.user_id, name: [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ') }];
  return [];
}

/** Tells everyone affected by a new expense (participants and the payer) except the person who recorded it. */
export async function notifyExpense(env: Env, m: any, e: { desc: string; total: number; payerId: string; allocs: Allocation[] }, ctx?: { waitUntil(p: Promise<unknown>): void }) {
  const run = async () => {
    const ms = await activeMembers(env, m.dormitory_id);
    const name = (id: string) => ms.find((x) => x.id === id)?.display_name ?? '؟';
    const share = new Map(e.allocs.map((a) => [a.memberId, a.amount]));
    const targets = new Set([...share.keys(), e.payerId]);
    targets.delete(m.id);
    await Promise.allSettled([...targets].map(async (id) => {
      const x = ms.find((y) => y.id === id);
      if (!x?.telegram_user_id) return;
      let t = `${m.display_name} هزینه‌ی «${e.desc}» را به مبلغ ${formatToman(e.total)} ثبت کرد (اتاق «${m.dname}»).\nپرداخت‌کننده: ${id === e.payerId ? 'شما' : name(e.payerId)}`;
      t += share.has(id) ? `\nسهم شما: ${formatToman(share.get(id)!)}` : '\nشما در این هزینه سهمی ندارید.';
      await tg(env, 'sendMessage', { chat_id: x.telegram_user_id, text: t });
    }));
  };
  try { if (ctx?.waitUntil) ctx.waitUntil(run().catch(() => {})); else await run(); } catch { /* notifications must never break saving */ }
}
// ---------- settlements with confirmation ----------
async function notifyUser(env: Env, memberId: string, text: string, kb?: any[][]) {
  const r = await q1(env, 'SELECT telegram_user_id FROM members WHERE id=?', memberId);
  if (r?.telegram_user_id) await tg(env, 'sendMessage', { chat_id: r.telegram_user_id, text, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) });
  return !!r?.telegram_user_id;
}
/** Only the debtor can record "I paid"; it stays pending until the recipient confirms. */
export async function createPendingSettlement(env: Env, m: any, from: string, to: string, amount: number): Promise<{ ok: true; id: string; recipientNotified: boolean; direct: boolean } | { ok: false; error: string }> {
  if (m.id !== from) return { ok: false, error: 'فقط خودِ بدهکار می‌تواند پرداخت خودش را ثبت کند.' };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: 'مبلغ نامعتبر است' };
  const { plan, names } = await ledger(env, m.dormitory_id);
  const p = plan.find((x) => x.fromId === from && x.toId === to);
  const pend = (await q1(env, `SELECT COALESCE(SUM(amount),0) AS s FROM settlements WHERE dormitory_id=? AND from_member_id=? AND to_member_id=? AND status='pending'`, m.dormitory_id, from, to)).s;
  if (!p || amount + pend > p.amount) return { ok: false, error: pend ? 'یک پرداخت در انتظار تأیید دارید و این مبلغ بیشتر از بدهی باقی‌مانده است.' : 'این مبلغ بیشتر از بدهی شماست یا بدهی‌ای وجود ندارد.' };
  const seq = (await q1(env, 'SELECT COUNT(*) AS n FROM settlements WHERE dormitory_id=?', m.dormitory_id)).n;
  const id = `${m.dormitory_id}:settle:${seq}`; // PK collision makes a concurrent duplicate fail
  const direct = m.rc === 0; // room option: no creditor confirmation needed -> applied immediately
  try {
    await env.DB.batch([
      st(env, `INSERT INTO settlements(id,dormitory_id,from_member_id,to_member_id,amount,settled_on,status,recorded_by,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, m.dormitory_id, from, to, amount, today(), direct ? 'confirmed' : 'pending', m.id, direct ? m.id : null, direct ? new Date().toISOString() : null),
      st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`, m.dormitory_id, m.id, 'settlement', id, direct ? 'direct' : 'request', JSON.stringify({ from, to, amount })),
    ]);
  } catch { return { ok: false, error: 'ثبت انجام نشد؛ دوباره تلاش کنید.' }; }
  if (direct) {
    const n = await notifyUser(env, to, `${names.get(from)} پرداخت ${formatToman(amount)} به شما را ثبت کرد و در ترازها اعمال شد (اتاق «${m.dname}»).`);
    return { ok: true, id, recipientNotified: n, direct: true };
  }
  const notified = await notifyUser(env, to, `${names.get(from)} می‌گوید ${formatToman(amount)} به شما پرداخت کرده (اتاق «${m.dname}»).\nآیا پول به دستتان رسیده؟`, [[{ text: 'بله، دریافت شد', callback_data: 'sc:ok:' + id }, { text: 'نه، رد شود', callback_data: 'sc:no:' + id }]]);
  return { ok: true, id, recipientNotified: notified, direct: false };
}
/** After an expense edit, cancel pending payments that no longer fit the new debts (and tell the payer). */
export async function reconcilePending(env: Env, dorm: string, why: string): Promise<number> {
  const { plan, names } = await ledger(env, dorm);
  const pend = await qa(env, `SELECT id,from_member_id,to_member_id,amount FROM settlements WHERE dormitory_id=? AND status='pending' ORDER BY rowid`, dorm);
  const left = new Map<string, number>(plan.map((p) => [p.fromId + '>' + p.toId, p.amount]));
  let n = 0;
  for (const s of pend) {
    const k = s.from_member_id + '>' + s.to_member_id, avail = left.get(k) ?? 0;
    if (s.amount <= avail) { left.set(k, avail - s.amount); continue; }
    const r = await env.DB.prepare(`UPDATE settlements SET status='cancelled' WHERE id=? AND status='pending'`).bind(s.id).run();
    if (!r.meta?.changes) continue;
    n++;
    await ex(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action) VALUES(?,?,?,?,?)`, dorm, s.from_member_id, 'settlement', s.id, 'cancelled');
    await notifyUser(env, s.from_member_id, `پرداخت در انتظار شما (${formatToman(s.amount)} به ${names.get(s.to_member_id)}) لغو شد، چون ${why}. اگر هنوز بدهکار هستید دوباره ثبت کنید.`);
  }
  return n;
}
// ---------- clear history (reversible for 48 hours) ----------
export const ARCHIVE_HOURS = 48;
const hoursLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 3_600_000));
const faDate = (iso: string) => { try { return new Date(iso).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'short', timeStyle: 'short' }); } catch { return iso; } };

/** Permanently deletes archives whose 48 hours are over. Safe to call often. */
export async function purgeExpiredArchives(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const old = await q1(env, 'SELECT COUNT(*) AS n FROM archives WHERE expires_at <= ?', now);
  if (!old?.n) return;
  await env.DB.batch([
    st(env, `DELETE FROM archived_allocations WHERE archive_id IN (SELECT id FROM archives WHERE expires_at <= ?)`, now),
    st(env, `DELETE FROM archived_expenses WHERE archive_id IN (SELECT id FROM archives WHERE expires_at <= ?)`, now),
    st(env, `DELETE FROM archived_settlements WHERE archive_id IN (SELECT id FROM archives WHERE expires_at <= ?)`, now),
    st(env, `DELETE FROM archives WHERE expires_at <= ?`, now),
  ]);
}
export const listArchives = (env: Env, dorm: string) => qa(env, 'SELECT id, created_at, expires_at, n_expenses, n_settlements FROM archives WHERE dormitory_id=? AND expires_at > ? ORDER BY created_at DESC', dorm, new Date().toISOString());

async function notifyAll(env: Env, dorm: string, exceptMemberId: string, text: string) {
  const ms = await qa(env, 'SELECT id FROM members WHERE dormitory_id=? AND active=1 AND telegram_user_id IS NOT NULL AND id<>?', dorm, exceptMemberId);
  for (const x of ms) { try { await notifyUser(env, x.id, text); } catch { /* ignore delivery errors */ } }
}

/** Moves ALL expenses + settlements of the room into the archive (balances become zero). Admin only. */
export async function clearHistory(env: Env, m: any): Promise<{ ok: true; id: string; expenses: number; settlements: number; expiresAt: string } | { ok: false; error: string }> {
  if (!isAdmin(m)) return { ok: false, error: 'فقط مدیر اتاق می‌تواند تاریخچه را پاک کند.' };
  await purgeExpiredArchives(env);
  const d = m.dormitory_id;
  const e = (await q1(env, 'SELECT COUNT(*) AS n FROM expenses WHERE dormitory_id=?', d)).n as number;
  const s = (await q1(env, 'SELECT COUNT(*) AS n FROM settlements WHERE dormitory_id=?', d)).n as number;
  if (!e && !s) return { ok: false, error: 'تاریخچه‌ای برای پاک کردن وجود ندارد.' };
  const id = uuid(), now = new Date(), expiresAt = new Date(now.getTime() + ARCHIVE_HOURS * 3_600_000).toISOString();
  await env.DB.batch([
    st(env, `INSERT INTO archives(id,dormitory_id,created_by,created_at,expires_at,n_expenses,n_settlements) VALUES(?,?,?,?,?,?,?)`, id, d, m.id, now.toISOString(), expiresAt, e, s),
    st(env, `INSERT INTO archived_expenses SELECT *, ? FROM expenses WHERE dormitory_id=?`, id, d),
    st(env, `INSERT INTO archived_allocations SELECT a.*, ? FROM expense_allocations a JOIN expenses x ON x.id=a.expense_id WHERE x.dormitory_id=?`, id, d),
    st(env, `INSERT INTO archived_settlements SELECT *, ? FROM settlements WHERE dormitory_id=?`, id, d),
    st(env, `DELETE FROM expense_allocations WHERE expense_id IN (SELECT id FROM expenses WHERE dormitory_id=?)`, d),
    st(env, `DELETE FROM expenses WHERE dormitory_id=?`, d),
    st(env, `DELETE FROM settlements WHERE dormitory_id=?`, d),
    st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`, d, m.id, 'archive', id, 'clear', JSON.stringify({ expenses: e, settlements: s, expiresAt })),
  ]);
  await notifyAll(env, d, m.id, `مدیر تاریخچه‌ی حساب‌های اتاق «${m.dname}» را پاک کرد (${e} هزینه، ${s} پرداخت) و ترازها صفر شد.\nتا ${ARCHIVE_HOURS} ساعت قابل بازگردانی است؛ بعد از آن برای همیشه حذف می‌شود.`);
  return { ok: true, id, expenses: e, settlements: s, expiresAt };
}

/** Puts an archived history back (merged with anything recorded since). Admin only, within 48 hours. */
export async function restoreHistory(env: Env, m: any, archiveId: string): Promise<{ ok: true; expenses: number; settlements: number } | { ok: false; error: string }> {
  if (!isAdmin(m)) return { ok: false, error: 'فقط مدیر اتاق می‌تواند تاریخچه را بازگرداند.' };
  await purgeExpiredArchives(env);
  const a = await q1(env, 'SELECT * FROM archives WHERE id=? AND dormitory_id=?', archiveId, m.dormitory_id);
  if (!a) return { ok: false, error: 'مهلت بازگردانی تمام شده یا این تاریخچه پیدا نشد.' };
  await env.DB.batch([
    st(env, `INSERT INTO expenses(id,dormitory_id,description,category_id,total_amount,payer_id,currency,method,expense_date,notes,created_by,created_at,status,version,cancelled_by,cancel_reason,category) SELECT id,dormitory_id,description,category_id,total_amount,payer_id,currency,method,expense_date,notes,created_by,created_at,status,version,cancelled_by,cancel_reason,category FROM archived_expenses WHERE archive_id=?`, archiveId),
    st(env, `INSERT INTO expense_allocations(expense_id,member_id,amount) SELECT expense_id,member_id,amount FROM archived_allocations WHERE archive_id=?`, archiveId),
    // settlement ids are re-generated: new ids were reused from 0 after the clear
    st(env, `INSERT INTO settlements(id,dormitory_id,from_member_id,to_member_id,amount,settled_on,note,status,recorded_by,created_at,confirmed_by,confirmed_at) SELECT dormitory_id || ':settle:x' || lower(hex(randomblob(4))),dormitory_id,from_member_id,to_member_id,amount,settled_on,note,status,recorded_by,created_at,confirmed_by,confirmed_at FROM archived_settlements WHERE archive_id=?`, archiveId),
    st(env, `DELETE FROM archived_allocations WHERE archive_id=?`, archiveId),
    st(env, `DELETE FROM archived_expenses WHERE archive_id=?`, archiveId),
    st(env, `DELETE FROM archived_settlements WHERE archive_id=?`, archiveId),
    st(env, `DELETE FROM archives WHERE id=?`, archiveId),
    st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`, m.dormitory_id, m.id, 'archive', archiveId, 'restore', JSON.stringify({ expenses: a.n_expenses, settlements: a.n_settlements })),
  ]);
  await notifyAll(env, m.dormitory_id, m.id, `مدیر تاریخچه‌ی حساب‌های اتاق «${m.dname}» را بازگرداند (${a.n_expenses} هزینه، ${a.n_settlements} پرداخت).`);
  return { ok: true, expenses: a.n_expenses, settlements: a.n_settlements };
}
async function cmdClearHistory(env: Env, chat: number, m: any) {
  if (!isAdmin(m)) return send(env, chat, 'فقط مدیر اتاق می‌تواند تاریخچه را پاک کند.');
  return send(env, chat, `⚠️ همه‌ی هزینه‌ها و پرداخت‌های اتاق «${m.dname}» پاک می‌شوند و ترازها صفر می‌شود (اعضا می‌مانند).\nتا ${ARCHIVE_HOURS} ساعت می‌توانید با /restorehistory برگردانید؛ بعد از آن برای همیشه حذف می‌شود و همه‌ی اعضا خبردار می‌شوند.\nادامه می‌دهید؟`, [[{ text: '🗑 بله، تاریخچه پاک شود', callback_data: 'ch:go' }], [{ text: 'انصراف', callback_data: 'ch:no' }]]);
}
async function cmdRestoreHistory(env: Env, chat: number, m: any) {
  if (!isAdmin(m)) return send(env, chat, 'فقط مدیر اتاق می‌تواند تاریخچه را بازگرداند.');
  await purgeExpiredArchives(env);
  const list = await listArchives(env, m.dormitory_id);
  if (!list.length) return send(env, chat, `تاریخچه‌ی قابل بازگردانی وجود ندارد. (تاریخچه‌ی پاک‌شده تا ${ARCHIVE_HOURS} ساعت نگه داشته می‌شود.)`);
  return send(env, chat, 'کدام تاریخچه بازگردانده شود؟', list.map((x: any) => [{ text: `${faDate(x.created_at)} — ${x.n_expenses} هزینه، ${x.n_settlements} پرداخت — ${hoursLeft(x.expires_at)} ساعت مانده`, callback_data: 'ch:undo:' + x.id }]));
}

export async function respondSettlement(env: Env, uid: number, id: string, action: 'ok' | 'no' | 'x'): Promise<{ ok: boolean; message: string }> {
  const s = await q1(env, `SELECT * FROM settlements WHERE id=?`, id);
  if (!s || s.status !== 'pending') return { ok: false, message: 'این پرداخت دیگر در انتظار تأیید نیست.' };
  const actor = await q1(env, `SELECT * FROM members WHERE dormitory_id=? AND telegram_user_id=? AND active=1`, s.dormitory_id, uid);
  if (!actor) return { ok: false, message: 'شما عضو این اتاق نیستید.' };
  const recip = await q1(env, 'SELECT telegram_user_id FROM members WHERE id=?', s.to_member_id);
  const { plan, names } = await ledger(env, s.dormitory_id);
  const label = `${names.get(s.from_member_id)} ← ${names.get(s.to_member_id)}: ${formatToman(s.amount)}`;
  const setStatus = async (status: string) => {
    const r = await env.DB.prepare(`UPDATE settlements SET status=?, confirmed_by=?, confirmed_at=? WHERE id=? AND status='pending'`).bind(status, actor.id, new Date().toISOString(), id).run();
    if (!r.meta?.changes) return false;
    await ex(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action) VALUES(?,?,?,?,?)`, s.dormitory_id, actor.id, 'settlement', id, status);
    return true;
  };
  if (action === 'x') {
    if (actor.id !== s.from_member_id) return { ok: false, message: 'فقط پرداخت‌کننده می‌تواند درخواستش را لغو کند.' };
    return (await setStatus('cancelled')) ? { ok: true, message: `درخواست لغو شد.\n${label}` } : { ok: false, message: 'این پرداخت دیگر در انتظار نیست.' };
  }
  const canAct = actor.id === s.to_member_id || (isAdmin(actor) && !recip?.telegram_user_id);
  if (!canAct) return { ok: false, message: 'فقط دریافت‌کننده می‌تواند تأیید یا رد کند.' };
  if (action === 'no') {
    if (!(await setStatus('cancelled'))) return { ok: false, message: 'این پرداخت دیگر در انتظار نیست.' };
    await notifyUser(env, s.from_member_id, `پرداخت شما رد شد: ${label}`);
    return { ok: true, message: `رد شد.\n${label}` };
  }
  if (!plan.some((p) => p.fromId === s.from_member_id && p.toId === s.to_member_id && p.amount >= s.amount)) return { ok: false, message: 'ترازها در این فاصله عوض شده و این پرداخت دیگر معتبر نیست.' };
  if (!(await setStatus('confirmed'))) return { ok: false, message: 'این پرداخت دیگر در انتظار نیست.' };
  await notifyUser(env, s.from_member_id, `دریافت پولتان تأیید شد: ${label}`);
  return { ok: true, message: `تأیید شد و در ترازها اعمال شد.\n${label}` };
}
async function cmdRooms(env: Env, chat: number, uid: number, m: any) {
  const rooms = await myRooms(env, uid);
  const kb: any[][] = rooms.map((r) => [{ text: `${r.id === m.dormitory_id ? '✅ ' : ''}${r.name}`, callback_data: 'room:go:' + r.id }]);
  kb.push([{ text: 'ساخت اتاق جدید', callback_data: 'room:new' }, { text: 'پیوستن با کد', callback_data: 'room:join' }]);
  if (m.role === 'owner') kb.push([{ text: 'حذف اتاق فعلی', callback_data: 'room:del' }]);
  await send(env, chat, `اتاق‌های شما (اتاق فعال: «${m.dname}»). برای عوض کردن، روی اتاق بزنید:`, kb);
}

// ---------- add-expense flow ----------
async function startAdd(env: Env, chat: number, uid: number) {
  await setState(env, uid, { step: 'amount' });
  await send(env, chat, 'مبلغ هزینه را به تومان بفرستید (مثلاً ۵۰۰۰۰ یا 50,000). برای لغو: /cancel');
}
async function reviewText(env: Env, m: any, s: any) {
  const ms = await activeMembers(env, m.dormitory_id);
  const name = (id: string) => ms.find((x) => x.id === id)?.display_name ?? '؟';
  return `بررسی نهایی\n\nشرح: ${s.desc}\nمبلغ کل: ${formatToman(s.amount)}\nپرداخت‌کننده: ${name(s.payer)}\nروش: ${s.method === 'equal' ? 'مساوی' : 'سفارشی'}\nتعداد شرکت‌کنندگان: ${faNum(s.allocs.length)}\nتاریخ: ${fa(today())}\n\nسهم‌ها:\n` +
    s.allocs.map((a: Allocation) => `• ${name(a.memberId)}: ${formatToman(a.amount)}`).join('\n');
}
const REVIEW_KB = [[{ text: 'تأیید و ذخیره', callback_data: 'c:ok' }, { text: 'لغو', callback_data: 'c:no' }]];
/** Main members first; guest members in their own block below (a non-clickable header row). */
const partsKb = (ms: any[], sel: string[]) => {
  const row = (x: any) => [{ text: `${sel.includes(x.id) ? '✅' : '⬜'} ${x.display_name}`, callback_data: `t:${x.id}` }];
  const subs = ms.filter((x) => x.is_substitute);
  return [
    ...ms.filter((x) => !x.is_substitute).map(row),
    ...(subs.length ? [[{ text: '┄┄ اعضای مهمان (بدون تیک، مگر پرداخت‌کننده) ┄┄', callback_data: 'noop' }], ...subs.map(row)] : []),
    [{ text: 'همه', callback_data: 't:all' }, ...(subs.length ? [{ text: 'پیش‌فرض', callback_data: 't:def' }] : []), { text: 'هیچ‌کس', callback_data: 't:none' }],
    [{ text: `ادامه (${faNum(sel.length)} نفر)`, callback_data: 't:ok' }],
  ];
};

async function stateText(env: Env, chat: number, uid: number, m: any, s: any, text: string) {
  if (s.step === 'amount') {
    const r = parseAmount(text);
    if (!r.ok) return send(env, chat, r.error);
    await setState(env, uid, { ...s, step: 'desc', amount: r.value });
    return send(env, chat, 'شرح هزینه را بنویسید (مثلاً: خرید نان و پنیر)');
  }
  if (s.step === 'desc') {
    if (text.length < 1 || text.length > 200) return send(env, chat, 'شرح باید بین ۱ تا ۲۰۰ نویسه باشد.');
    await setState(env, uid, { ...s, step: 'payer', desc: text });
    const ms = await activeMembers(env, m.dormitory_id);
    return send(env, chat, 'چه کسی پول را پرداخت کرد؟', ms.map((x) => [{ text: x.display_name, callback_data: `p:${x.id}` }]));
  }
  if (s.step === 'custom') {
    const ms = await activeMembers(env, m.dormitory_id);
    const shares: Allocation[] = [];
    for (const tok of text.split(/[\s,،\n]+/).filter(Boolean)) {
      const mt = normalizeDigits(tok.replace(/٫/g, '.')).match(/^(\d+)[=:](\d+(?:\.\d+)?)$/);
      const target = mt ? ms[parseInt(mt[1], 10) - 1] : undefined;
      const amt = mt ? parseAmount(mt[2]) : null;
      if (!target || !amt || !amt.ok) return send(env, chat, `«${tok}» نامعتبر است. قالب: شماره=مبلغ، مثل 1=30000 2=20000`);
      shares.push({ memberId: target.id, amount: amt.value });
    }
    const r = customAllocation(s.amount, shares);
    if (!r.ok) return send(env, chat, `${r.error}${r.remaining !== undefined ? `\nباقی‌مانده: ${formatToman(r.remaining)}` : ''}\nدوباره بفرستید.`);
    const ns = { ...s, step: 'review', allocs: r.allocations };
    await setState(env, uid, ns);
    return send(env, chat, await reviewText(env, m, ns), REVIEW_KB);
  }
  return send(env, chat, 'از دکمه‌های زیر پیام قبلی استفاده کنید یا /cancel بزنید.');
}

async function saveExpense(env: Env, m: any, s: any, ctx?: { waitUntil(p: Promise<unknown>): void }) {
  const id = uuid();
  await env.DB.batch([
    st(env, `INSERT INTO expenses(id,dormitory_id,description,total_amount,payer_id,method,expense_date,created_by) VALUES(?,?,?,?,?,?,?,?)`, id, m.dormitory_id, s.desc, s.amount, s.payer, s.method, today(), m.id),
    ...s.allocs.map((a: Allocation) => st(env, `INSERT INTO expense_allocations(expense_id,member_id,amount) VALUES(?,?,?)`, id, a.memberId, a.amount)),
    st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`, m.dormitory_id, m.id, 'expense', id, 'create', JSON.stringify({ total: s.amount, payer: s.payer, method: s.method })),
  ]);
  await notifyExpense(env, m, { desc: s.desc, total: s.amount, payerId: s.payer, allocs: s.allocs }, ctx);
}

async function callback(env: Env, cq: any, ctx?: { waitUntil(p: Promise<unknown>): void }) {
  const uid = cq.from.id, chat = cq.message?.chat?.id ?? uid, data: string = cq.data ?? '';
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (data === 'noop') return; // section header buttons
  const m = await me(env, uid);
  if (data === 'start:new' && !m) { await setState(env, uid, { step: 'newdorm' }); return send(env, chat, 'نام خوابگاه را بنویسید:'); }
  if (data === 'start:join' && !m) { await setState(env, uid, { step: 'join' }); return send(env, chat, 'کد دعوت را بنویسید:'); }
  if (data === 'room:new') { await setState(env, uid, { step: 'newdorm' }); return send(env, chat, 'نام اتاق جدید را بنویسید:'); }
  if (data === 'room:join') { await setState(env, uid, { step: 'join' }); return send(env, chat, 'کد دعوت را بنویسید:'); }
  if (data.startsWith('sc:')) { const [, a, ...rest] = data.split(':'); const r = await respondSettlement(env, uid, rest.join(':'), a as any); return send(env, chat, r.message); }
  if (data.startsWith('mr:')) { const [, a, ...rest] = data.split(':'); const r = await respondMemberRequest(env, uid, cq.from, rest.join(':'), a === 'ok' ? 'ok' : 'no'); return send(env, chat, r.message, r.ok && a === 'ok' ? MENU : undefined); }
  if (!m) return send(env, chat, 'ابتدا /start را بزنید.');
  if (data === 'lv:no') return send(env, chat, 'انصراف شد؛ در اتاق می‌مانید.');
  if (data === 'lv:go') { const r = await leaveRoom(env, uid); if (!r.ok) return send(env, chat, r.error); const nx = await me(env, uid); return send(env, chat, `از اتاق «${r.room}» خارج شدید.` + (nx ? ` اکنون در اتاق «${nx.dname}» هستید.` : ' می‌توانید اتاق جدید بسازید یا با کد دعوت بپیوندید.'), nx ? MENU : [[{ text: 'ساخت اتاق جدید', callback_data: 'start:new' }], [{ text: 'دارم کد دعوت', callback_data: 'start:join' }]]); }
  if (data === 'rc:1' || data === 'rc:0') {
    if (!isAdmin(m)) return send(env, chat, 'فقط مدیر می‌تواند این گزینه را تغییر دهد.');
    await ex(env, 'UPDATE dormitories SET require_confirm=? WHERE id=?', data === 'rc:1' ? 1 : 0, m.dormitory_id);
    await send(env, chat, data === 'rc:1' ? 'پرداخت دنگ‌ها نیاز به تأیید طلب‌کار دارد.' : 'پرداخت دنگ‌ها بدون تأیید طلب‌کار فوراً ثبت می‌شود.');
    return askName(env, chat, uid, await me(env, uid));
  }
  if (data === 'ch:no') return send(env, chat, 'انصراف شد؛ چیزی پاک نشد.');
  if (data === 'ch:go') {
    const r = await clearHistory(env, m);
    return send(env, chat, r.ok ? `تاریخچه پاک شد (${r.expenses} هزینه، ${r.settlements} پرداخت) و ترازها صفر است.\nتا ${ARCHIVE_HOURS} ساعت می‌توانید با /restorehistory برگردانید.` : r.error);
  }
  if (data.startsWith('ch:undo:')) {
    const r = await restoreHistory(env, m, data.slice(8));
    return send(env, chat, r.ok ? `بازگردانده شد (${r.expenses} هزینه، ${r.settlements} پرداخت).` : r.error);
  }
  if (data === 'pf:keep') return askNick(env, chat, uid);
  if (data === 'pf:skip') return finishProfile(env, chat, uid);
  if (data.startsWith('room:go:')) {
    if (!(await switchRoom(env, uid, data.slice(8)))) return send(env, chat, 'اتاق پیدا نشد.');
    const nm2 = await me(env, uid);
    return send(env, chat, `اکنون در اتاق «${nm2.dname}» هستید.`, MENU);
  }
  if (data === 'room:del') {
    if (m.role !== 'owner') return send(env, chat, 'فقط مدیر اصلی می‌تواند اتاق را حذف کند.');
    return send(env, chat, `⚠️ اتاق «${m.dname}» حذف شود؟\nهمه‌ی اعضا دیگر آن را نمی‌بینند. این کار از داخل ربات برگشت‌پذیر نیست.`, [[{ text: 'بله، حذف شود', callback_data: 'room:delok:' + m.dormitory_id }, { text: 'انصراف', callback_data: 'room:no' }]]);
  }
  if (data === 'room:no') return send(env, chat, 'انصراف داده شد.');
  if (data.startsWith('room:delok:')) {
    const r = await deleteRoom(env, uid, data.slice(11));
    if (!r.ok) return send(env, chat, r.error!);
    const next = await me(env, uid);
    return send(env, chat, next ? `اتاق حذف شد. اکنون در اتاق «${next.dname}» هستید.` : 'اتاق حذف شد. می‌توانید اتاق جدید بسازید یا با کد دعوت بپیوندید.', next ? MENU : [[{ text: 'ساخت اتاق جدید', callback_data: 'start:new' }], [{ text: 'دارم کد دعوت', callback_data: 'start:join' }]]);
  }
  if (data === 'mem:ids') {
    if (!isAdmin(m)) return send(env, chat, 'فقط مدیر می‌تواند عضو اضافه کند.');
    await setState(env, uid, { step: 'addids' });
    return send(env, chat, 'یکی از این کارها را بکنید:\n• دکمه‌ی «انتخاب از مخاطبین» را بزنید و افراد را انتخاب کنید\n• یک پیام از آن فرد را برای من فوروارد کنید\n• یا آیدی عددی تلگرام آن‌ها را بنویسید (چند تا را با فاصله یا خط جدید؛ می‌توانید بعد از آیدی اسم هم بنویسید، مثل: 123456789 رضا)\nآیدی عددی را از ربات @userinfobot می‌توانند بگیرند.', { keyboard: [[{ text: 'انتخاب از مخاطبین', request_users: { request_id: 1, user_is_bot: false, max_quantity: 10, request_name: true } }], [{ text: 'انصراف' }]], resize_keyboard: true, one_time_keyboard: true });
  }
  if (data === 'mem:sub') return cmdSubstitutes(env, chat, m);
  if (data.startsWith('sub:')) {
    const r = await setSubstitute(env, m, data.slice(4));
    if (!r.ok) return send(env, chat, r.error);
    const ms = await activeMembers(env, m.dormitory_id);
    // edit the same message in place so several people can be switched one after another
    if (cq.message?.message_id) await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: subKb(ms) } });
    else await send(env, chat, SUB_TEXT, subKb(ms));
    return;
  }
  if (data === 'mem:add') {
    if (!isAdmin(m)) return send(env, chat, 'فقط مدیر می‌تواند عضو اضافه کند.');
    await setState(env, uid, { step: 'addmember' });
    return send(env, chat, 'نام عضو جدید را بنویسید:');
  }
  if (data === 'mem:inv') {
    if (!isAdmin(m)) return send(env, chat, 'فقط مدیر می‌تواند دعوت بسازد.');
    const un = (await activeMembers(env, m.dormitory_id)).filter((x) => !x.telegram_user_id);
    return send(env, chat, 'برای چه کسی کد بسازم؟', [...un.map((x) => [{ text: x.display_name, callback_data: 'inv:' + x.id }]), [{ text: 'یک نفر جدید', callback_data: 'inv:new' }]]);
  }
  if (data.startsWith('inv:')) {
    if (!isAdmin(m)) return send(env, chat, 'فقط مدیر می‌تواند دعوت بسازد.');
    const id = data.slice(4);
    if (id === 'new') return makeInvite(env, chat, m, null);
    const t = (await activeMembers(env, m.dormitory_id)).find((x) => x.id === id);
    if (!t || t.telegram_user_id) return send(env, chat, 'این عضو معتبر نیست یا قبلاً وصل شده است.');
    return makeInvite(env, chat, m, id);
  }
  if (data.startsWith('menu:')) {
    const k = data.slice(5);
    if (k === 'add') return startAdd(env, chat, uid);
    if (k === 'bal') return cmdBalance(env, chat, m);
    if (k === 'settle') return cmdSettle(env, chat, m);
    if (k === 'exp') return cmdExpenses(env, chat, m);
    if (k === 'mem') return cmdMembers(env, chat, m);
  }
  if (data.startsWith('pay:')) {
    // "pay:<toId>:<amount>" (the payer is whoever taps). The old 4-part form is still understood.
    const p = data.split(':');
    const [from, to, amt] = p.length === 3 ? [m.id, p[1], p[2]] : [p[1], p[2], p[3]];
    const r = await createPendingSettlement(env, m, from, to, Number(amt));
    if (!r.ok) return send(env, chat, r.error);
    return send(env, chat, r.direct ? 'ثبت شد و مستقیماً در ترازها اعمال شد (این اتاق نیاز به تأیید طلب‌کار ندارد).' : r.recipientNotified ? 'ثبت شد و برای تأیید به دریافت‌کننده پیام رفت. بعد از تأیید او در ترازها اعمال می‌شود.' : 'ثبت شد. دریافت‌کننده هنوز به تلگرام وصل نیست؛ مدیر باید در برنامه تأیید کند.');
  }
  const s = await getState(env, uid);
  if (!s) return send(env, chat, 'عملیات فعالی وجود ندارد. /add را بزنید.');
  if (data.startsWith('p:') && s.step === 'payer') {
    const ms = await activeMembers(env, m.dormitory_id);
    if (!ms.some((x) => x.id === data.slice(2))) return;
    await setState(env, uid, { ...s, step: 'method', payer: data.slice(2) });
    return send(env, chat, 'روش تقسیم؟', [[{ text: 'مساوی', callback_data: 'm:eq' }, { text: 'سفارشی', callback_data: 'm:cu' }]]);
  }
  if (data.startsWith('m:') && s.step === 'method') {
    const ms = await activeMembers(env, m.dormitory_id);
    if (data === 'm:eq') {
      const sel = defaultParticipants(ms, s.payer); // main members ticked; a guest only if they are the payer
      await setState(env, uid, { ...s, step: 'parts', method: 'equal', sel });
      return send(env, chat, 'چه کسانی در این هزینه شریک‌اند؟ اعضای اصلی تیک خورده‌اند و اعضای مهمان بدون تیک (مگر اینکه خودشان پرداخت کرده باشند). هر کس را که لازم است تیک بزنید یا بردارید، بعد «ادامه». (پرداخت‌کننده فقط اگر تیک بخورد سهم دارد)', partsKb(ms, sel));
    }
    await setState(env, uid, { ...s, step: 'custom', method: 'custom' });
    return send(env, chat, 'سهم هر نفر را به صورت «شماره=مبلغ» بفرستید. مجموع باید دقیقاً ' + formatToman(s.amount) + ' شود.\n' + ms.map((x, i) => `${i + 1}. ${x.display_name}${x.is_substitute ? ' (مهمان)' : ''}`).join('\n') + '\nمثال: 1=30000 2=20000\n(فقط کسانی را بنویسید که در این هزینه سهم دارند؛ اعضای مهمان را فقط اگر شریک‌اند.)');
  }
  if (data.startsWith('t:') && s.step === 'parts') {
    const ms = await activeMembers(env, m.dormitory_id);
    if (data === 't:ok') {
      const r = equalAllocation(s.amount, s.sel);
      if (!r.ok) return send(env, chat, s.sel.length ? r.error : 'حداقل یک نفر را انتخاب کنید.');
      const ns = { ...s, step: 'review', allocs: r.allocations };
      await setState(env, uid, ns);
      return send(env, chat, await reviewText(env, m, ns), REVIEW_KB);
    }
    let sel: string[];
    if (data === 't:all') sel = ms.map((x) => x.id);
    else if (data === 't:def' || data === 't:main') sel = defaultParticipants(ms, s.payer);
    else if (data === 't:none') sel = [];
    else {
      const id = data.slice(2);
      if (!ms.some((x) => x.id === id)) return;
      sel = s.sel.includes(id) ? s.sel.filter((x: string) => x !== id) : [...s.sel, id];
    }
    await setState(env, uid, { ...s, sel });
    // edit the same message in place so several people can be ticked one after another
    if (cq.message?.message_id) await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: partsKb(ms, sel) } });
    else await send(env, chat, 'انتخاب شرکت‌کنندگان:', partsKb(ms, sel));
    return;
  }
  if (data === 'c:no') { await clearState(env, uid); return send(env, chat, 'لغو شد. چیزی ذخیره نشد.'); }
  if (data === 'c:ok' && s.step === 'review') {
    const claim = await ex(env, `DELETE FROM bot_state WHERE telegram_user_id=?`, uid);
    if (!claim.meta?.changes) return;
    try { await saveExpense(env, m, s, ctx); } catch (e) { await setState(env, uid, s); console.log(JSON.stringify({ evt: 'save_failed' })); return send(env, chat, 'ذخیره انجام نشد. دوباره «تأیید» را بزنید.', REVIEW_KB); }
    const { net } = await ledger(env, m.dormitory_id);
    const mine = net.get(m.id) ?? 0;
    return send(env, chat, `هزینه ذخیره شد.\nتراز فعلی شما: ${mine === 0 ? 'صفر' : (mine > 0 ? 'طلبکار ' : 'بدهکار ') + formatToman(Math.abs(mine))}`, MENU);
  }
}

export async function handleUpdate(env: Env, u: any, ctx?: { waitUntil(p: Promise<unknown>): void }) {
  if (typeof u?.update_id !== 'number') return;
  const dup = await ex(env, 'INSERT OR IGNORE INTO processed_updates(update_id) VALUES(?)', u.update_id);
  if (!dup.meta?.changes) return; // webhook retry
  if (u.callback_query) return callback(env, u.callback_query, ctx);
  const msg = u.message;
  if (!msg?.from) return;
  const uid = msg.from.id, chat = msg.chat.id, text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (msg.chat.type !== 'private') {
    if (text.startsWith('/')) await send(env, chat, 'برای حفظ حریم خصوصی، لطفاً در پیام خصوصی با ربات صحبت کنید.');
    return;
  }
  {
    const shared = sharedEntries(msg);
    const m0 = shared.length || msg.contact || msg.forward_origin || msg.forward_from ? await me(env, uid) : null;
    const st0 = m0 ? await getState(env, uid) : null;
    const entries = shared.length ? shared : st0?.step === 'addids' ? forwardedEntries(msg) : [];
    if (m0 && entries.length) {
      await clearState(env, uid);
      if (!isAdmin(m0)) return send(env, chat, 'فقط مدیر می‌تواند عضو اضافه کند.', MENU);
      return send(env, chat, addedText(await addMembersByIds(env, m0, entries)), MENU);
    }
  }
  if (typeof msg.text !== 'string') return;
  const label = LABELS[text];
  const cmd = label ? [text, label, ''] : text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  const m = await me(env, uid);
  if (cmd) {
    const [, c, arg] = cmd;
    if (c === 'cancel') { await clearState(env, uid); return send(env, chat, 'لغو شد.'); }
    await clearState(env, uid);
    if (c === 'join') return cmdJoin(env, chat, uid, msg.from, arg);
    if (c === 'start') {
      if (m) { await send(env, chat, `سلام ${m.display_name}!\nخوابگاه «${m.dname}»`, MENU); await offerPendingRequests(env, chat, uid); return openAppButton(env, chat); }
      if (arg.trim()) return cmdJoin(env, chat, uid, msg.from, arg);
      await offerPendingRequests(env, chat, uid);
      return send(env, chat, 'سلام! چه کار می‌خواهید بکنید؟', [[{ text: 'ساخت خوابگاه جدید', callback_data: 'start:new' }], [{ text: 'دارم کد دعوت', callback_data: 'start:join' }]]);
    }
    if (c === 'help') return send(env, chat, HELP);
    if (c === 'backup') { // hidden: only the deploy owner (BACKUP_CHAT_ID) can trigger a backup by hand
      if (!env.BACKUP_CHAT_ID || String(uid) !== String(env.BACKUP_CHAT_ID)) return send(env, chat, 'دستور ناشناخته. /help');
      const r = await runBackup(env);
      return send(env, chat, r.ok ? `بکاپ گرفته شد: ${r.name} (${r.channels.join('، ')})` : `بکاپ ناموفق: ${r.errors.join(' | ') || r.skipped}`);
    }
    if (c === 'openapp' || c === 'app') return openAppButton(env, chat);
    if (!m) return send(env, chat, 'ابتدا /start را بزنید.');
    if (c === 'name' || c === 'nickname') return cmdProfile(env, chat, m, c, arg);
    if (c === 'leave') return m.role === 'owner' ? send(env, chat, 'مدیر اصلی نمی‌تواند اتاق را ترک کند. با /rooms اتاق را حذف کنید.') : send(env, chat, `از اتاق «${m.dname}» خارج می‌شوید؟ سابقه‌ی مالی‌تان می‌ماند. (فقط وقتی تراز شما صفر است.)`, [[{ text: 'بله، خارج شوم', callback_data: 'lv:go' }, { text: 'انصراف', callback_data: 'lv:no' }]]);
    if (c === 'clearhistory') return cmdClearHistory(env, chat, m);
    if (c === 'restorehistory') return cmdRestoreHistory(env, chat, m);
    if (c === 'add') return startAdd(env, chat, uid);
    if (c === 'balance') return cmdBalance(env, chat, m);
    if (c === 'settle') return cmdSettle(env, chat, m);
    if (c === 'rooms') return cmdRooms(env, chat, uid, m);
    if (c === 'expenses') return cmdExpenses(env, chat, m);
    if (c === 'members') return cmdMembers(env, chat, m);
    if (c === 'guests' || c === 'substitutes') return cmdSubstitutes(env, chat, m); // `substitutes` = the previous name, still accepted
    if (c === 'addmember') return cmdAddMember(env, chat, m, arg);
    if (c === 'invite') return cmdInvite(env, chat, m, arg);
    return send(env, chat, 'دستور ناشناخته. /help');
  }
  const s = await getState(env, uid);
  if (s?.step === 'newdorm') {
    if (text.length < 1 || text.length > 80) return send(env, chat, 'نام باید بین ۱ تا ۸۰ نویسه باشد.');
    await createDormitory(env, uid, msg.from, text);
    await send(env, chat, `خوابگاه «${text}» ساخته شد و شما مدیر آن هستید.\nاعضا را از دکمه‌ی «اعضا» اضافه کنید.`, MENU);
    return send(env, chat, 'یک تنظیم مهم: وقتی کسی می‌گوید دنگش را پرداخت کرده، آیا طلب‌کار باید تأیید کند؟ (بعداً در برنامه، بخش «بیشتر»، قابل تغییر است)', [[{ text: '✅ بله، نیاز به تأیید طلب‌کار', callback_data: 'rc:1' }], [{ text: '⏩ خیر، بدون تأیید ثبت شود', callback_data: 'rc:0' }]]);
  }
  if (s?.step === 'pname' && m) {
    if (text.length < 1 || text.length > 60) return send(env, chat, 'نام باید بین ۱ تا ۶۰ نویسه باشد.');
    await ex(env, 'UPDATE members SET display_name=? WHERE id=?', text, m.id);
    return askNick(env, chat, uid);
  }
  if (s?.step === 'pnick' && m) {
    if (text.length < 1 || text.length > 30) return send(env, chat, 'نام مستعار باید بین ۱ تا ۳۰ نویسه باشد.');
    await ex(env, 'UPDATE members SET nickname=? WHERE id=?', text, m.id);
    return finishProfile(env, chat, uid);
  }
  if (s?.step === 'join') { await clearState(env, uid); return cmdJoin(env, chat, uid, msg.from, text); }
  if (s?.step === 'addmember' && m) { await clearState(env, uid); return cmdAddMember(env, chat, m, text); }
  if (s?.step === 'addids' && m) {
    const entries = parseIdEntries(text);
    if (!entries.length) return send(env, chat, 'آیدی عددی پیدا نشد. فقط عدد (۵ رقم یا بیشتر) بنویسید یا از دکمه‌ی انتخاب مخاطبین استفاده کنید.');
    await clearState(env, uid);
    if (!isAdmin(m)) return send(env, chat, 'فقط مدیر می‌تواند عضو اضافه کند.', MENU);
    return send(env, chat, addedText(await addMembersByIds(env, m, entries)), MENU);
  }
  if (s && m) return stateText(env, chat, uid, m, s, text);
  return send(env, chat, m ? 'برای دیدن دستورها /help را بزنید.' : 'ابتدا /start را بزنید.', m ? MENU : undefined);
}
