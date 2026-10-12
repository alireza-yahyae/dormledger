import { validateInitData, rateLimited } from './security.ts';
import { me, myRooms, switchRoom, deleteRoom, activeMembers, isAdmin, today, ledger, createInviteCode, joinWithCode, createDormitory, createPendingSettlement, respondSettlement, reconcilePending, clearHistory, restoreHistory, purgeExpiredArchives, listArchives, parseIdEntries, addMembersByIds } from './bot.ts';
import { validMinor, SCALE } from './domain/money.ts';
import { equalAllocation, customAllocation } from './domain/allocation.ts';
import type { Allocation } from './domain/allocation.ts';

type Env = any;
export const CATEGORIES = ['غذا', 'قبوض', 'خرید خانه', 'حمل‌ونقل', 'تفریح', 'سایر'];
class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const bad = (m: string, code = 'validation') => new ApiError(400, code, m);
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const q1 = (env: Env, sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first();
const qa = async (env: Env, sql: string, ...a: unknown[]): Promise<any[]> => (await env.DB.prepare(sql).bind(...a).all()).results;
const st = (env: Env, sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a);
const str = (v: unknown, min: number, max: number, field: string) => {
  if (typeof v !== 'string') throw bad(`${field} نامعتبر است`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw bad(`${field} باید بین ${min} تا ${max} نویسه باشد`);
  return t;
};
const validDate = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('تاریخ نامعتبر است');
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('تاریخ نامعتبر است');
  if (d.getTime() > Date.now() + 2 * 864e5) throw bad('تاریخ نمی‌تواند در آینده باشد');
  if (d.getFullYear() < 2000) throw bad('تاریخ نامعتبر است');
  return v;
};

export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula-injection guard
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function buildCsv(rows: any[][]): string {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function stateFor(env: Env, m: any, uid: number) {
  const d = m.dormitory_id;
  const members = await qa(env, `SELECT id, display_name, nickname, role, active, telegram_user_id FROM members WHERE dormitory_id=? ORDER BY rowid`, d);
  const { net, plan } = await ledger(env, d);
  // Aggregate period data in SQL so dashboard insights are not limited to the 300-row activity feed.
  const todayIso = today();
  const currentMonth = todayIso.slice(0, 7);
  const monthStart = (offset: number) => { const [y, mo] = currentMonth.split('-').map(Number); const dt = new Date(Date.UTC(y, mo - 1 + offset, 1)); return dt.toISOString().slice(0, 10); };
  const monthlyRows = await qa(env, `SELECT substr(expense_date,1,7) AS month, SUM(total_amount) AS total, COUNT(*) AS count FROM expenses WHERE dormitory_id=? AND status='active' AND expense_date>=? GROUP BY substr(expense_date,1,7)`, d, monthStart(-5));
  const monthly = Object.fromEntries(monthlyRows.map((r) => [r.month, { total: Number(r.total || 0), count: Number(r.count || 0) }]));
  const exps = await qa(env, `SELECT id, description, total_amount, payer_id, method, expense_date, category, notes, status, version, created_by, cancel_reason FROM expenses WHERE dormitory_id=? ORDER BY expense_date DESC, rowid DESC LIMIT 300`, d);
  const als = await qa(env, `SELECT a.expense_id, a.member_id, a.amount FROM expense_allocations a WHERE a.expense_id IN (SELECT id FROM (SELECT id FROM expenses WHERE dormitory_id=? ORDER BY expense_date DESC, rowid DESC LIMIT 300))`, d);
  const by = new Map<string, any[]>();
  for (const a of als) { if (!by.has(a.expense_id)) by.set(a.expense_id, []); by.get(a.expense_id)!.push({ m: a.member_id, a: a.amount }); }
  const sets = await qa(env, `SELECT id, from_member_id, to_member_id, amount, settled_on FROM settlements WHERE dormitory_id=? AND status='confirmed' ORDER BY rowid DESC LIMIT 30`, d);
  const pend = await qa(env, `SELECT id, from_member_id, to_member_id, amount, settled_on FROM settlements WHERE dormitory_id=? AND status='pending' ORDER BY rowid`, d);
  await purgeExpiredArchives(env);
  const archives = await listArchives(env, d);
  const rooms = await myRooms(env, uid);
  const totals = { total: 0, paid: {} as Record<string, number>, share: {} as Record<string, number>, category: {} as Record<string, number> };
  const expenses = exps.map((e) => {
    const allocs = by.get(e.id) ?? [];
    if (e.status === 'active') {
      totals.total += e.total_amount;
      totals.paid[e.payer_id] = (totals.paid[e.payer_id] ?? 0) + e.total_amount;
      for (const a of allocs) totals.share[a.m] = (totals.share[a.m] ?? 0) + a.a;
      const c = e.category || 'سایر';
      totals.category[c] = (totals.category[c] ?? 0) + e.total_amount;
    }
    return { id: e.id, desc: e.description, total: e.total_amount, payer: e.payer_id, method: e.method, date: e.expense_date, category: e.category, notes: e.notes, status: e.status, version: e.version, by: e.created_by, reason: e.cancel_reason, allocs };
  });
  return {
    me: { id: m.id, name: m.display_name, nick: m.nickname ?? '', role: m.role, admin: isAdmin(m) },
    dorm: { id: m.dormitory_id, name: m.dname, requireConfirm: m.rc !== 0 },
    members: members.map((x) => ({ id: x.id, name: x.display_name, nick: x.nickname ?? '', role: x.role, active: !!x.active, linked: !!x.telegram_user_id })),
    balances: Object.fromEntries(net),
    plan: plan.map((p) => ({ from: p.fromId, to: p.toId, amount: p.amount })),
    rooms: rooms.map((r) => ({ id: r.id, name: r.name, role: r.role, current: r.id === m.dormitory_id })),
    pending: pend.map((x) => ({ id: x.id, from: x.from_member_id, to: x.to_member_id, amount: x.amount, date: x.settled_on })),
    expenses, settlements: sets.map((s) => ({ id: s.id, from: s.from_member_id, to: s.to_member_id, amount: s.amount, date: s.settled_on })),
    archives: archives.map((a: any) => ({ id: a.id, createdAt: a.created_at, expiresAt: a.expires_at, expenses: a.n_expenses, settlements: a.n_settlements })),
    totals, categories: CATEGORIES, today: todayIso, monthly,
  };
}

async function parseExpense(env: Env, m: any, b: any) {
  const amt = validMinor(Number(b.amount));
  if (!amt.ok) throw bad(amt.error);
  const desc = str(b.description, 1, 200, 'شرح');
  const notes = b.notes ? str(b.notes, 0, 300, 'یادداشت') : null;
  const category = b.category && CATEGORIES.includes(b.category) ? b.category : null;
  const date = validDate(b.date ?? today());
  const ms = await activeMembers(env, m.dormitory_id);
  const ids = new Set(ms.map((x) => x.id));
  if (typeof b.payerId !== 'string' || !ids.has(b.payerId)) throw bad('پرداخت‌کننده نامعتبر است');
  let allocs: Allocation[];
  if (b.method === 'equal') {
    if (!Array.isArray(b.participants) || b.participants.some((x: unknown) => typeof x !== 'string' || !ids.has(x))) throw bad('شرکت‌کنندگان نامعتبرند');
    const r = equalAllocation(amt.value, b.participants);
    if (!r.ok) throw bad(r.error);
    allocs = r.allocations;
  } else if (b.method === 'custom') {
    if (!Array.isArray(b.shares)) throw bad('سهم‌ها نامعتبرند');
    const shares: Allocation[] = [];
    for (const s of b.shares) {
      if (!s || typeof s.memberId !== 'string' || !ids.has(s.memberId) || typeof s.amount !== 'number') throw bad('سهم‌ها نامعتبرند');
      shares.push({ memberId: s.memberId, amount: s.amount });
    }
    const r = customAllocation(amt.value, shares);
    if (!r.ok) throw bad(r.error);
    allocs = r.allocations;
  } else throw bad('روش تقسیم نامعتبر است');
  return { amt: amt.value, desc, notes, category, date, payerId: b.payerId as string, method: b.method as string, allocs };
}

async function createExpense(env: Env, m: any, b: any) {
  const key = str(b.key, 8, 64, 'کلید');
  const prev = await q1(env, 'SELECT response_json FROM idempotency_keys WHERE dormitory_id=? AND key=?', m.dormitory_id, key);
  if (prev) return JSON.parse(prev.response_json);
  const p = await parseExpense(env, m, b);
  const { desc, notes, category, date, allocs } = p;
  const id = crypto.randomUUID();
  const resp = { id };
  try {
    await env.DB.batch([
      st(env, `INSERT INTO expenses(id,dormitory_id,description,category,total_amount,payer_id,method,expense_date,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, m.dormitory_id, desc, category, p.amt, b.payerId, b.method, date, notes, m.id),
      ...allocs.map((a) => st(env, `INSERT INTO expense_allocations(expense_id,member_id,amount) VALUES(?,?,?)`, id, a.memberId, a.amount)),
      st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`, m.dormitory_id, m.id, 'expense', id, 'create', JSON.stringify({ total: p.amt, payer: b.payerId, method: b.method })),
      st(env, `INSERT INTO idempotency_keys(dormitory_id,key,response_json) VALUES(?,?,?)`, m.dormitory_id, key, JSON.stringify(resp)),
    ]);
  } catch (e) {
    const again = await q1(env, 'SELECT response_json FROM idempotency_keys WHERE dormitory_id=? AND key=?', m.dormitory_id, key);
    if (again) return JSON.parse(again.response_json); // concurrent duplicate request
    throw e;
  }
  return resp;
}

/** Edit an active expense (creator or admin). Allocations are replaced atomically; `version` guards against concurrent edits. */
async function updateExpense(env: Env, m: any, b: any) {
  const e = await q1(env, `SELECT id, status, version, created_by, total_amount, payer_id, method FROM expenses WHERE id=? AND dormitory_id=?`, String(b.id), m.dormitory_id);
  if (!e) throw new ApiError(404, 'not_found', 'هزینه پیدا نشد');
  if (e.status !== 'active') throw bad('هزینه‌ی لغوشده را نمی‌توان ویرایش کرد');
  if (e.created_by !== m.id && !isAdmin(m)) throw new ApiError(403, 'forbidden', 'فقط ثبت‌کننده یا مدیر می‌تواند هزینه را ویرایش کند');
  const conflict = () => new ApiError(409, 'conflict', 'این هزینه در این فاصله تغییر کرده است. صفحه را تازه کنید');
  if (Number(b.version) !== e.version) throw conflict();
  const p = await parseExpense(env, m, b);
  const guard = `EXISTS (SELECT 1 FROM expenses WHERE id=? AND status='active' AND version=?)`;
  await env.DB.batch([
    st(env, `DELETE FROM expense_allocations WHERE expense_id=? AND ${guard}`, e.id, e.id, e.version),
    ...p.allocs.map((a) => st(env, `INSERT INTO expense_allocations(expense_id,member_id,amount) SELECT ?,?,? WHERE ${guard}`, e.id, a.memberId, a.amount, e.id, e.version)),
    st(env, `UPDATE expenses SET description=?, category=?, total_amount=?, payer_id=?, method=?, expense_date=?, notes=?, version=version+1 WHERE id=? AND status='active' AND version=?`, p.desc, p.category, p.amt, p.payerId, p.method, p.date, p.notes, e.id, e.version),
    st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,before_json,after_json) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=?)`, m.dormitory_id, m.id, 'expense', e.id, 'update', JSON.stringify({ total: e.total_amount, payer: e.payer_id, method: e.method }), JSON.stringify({ total: p.amt, payer: p.payerId, method: p.method }), e.id, e.version + 1),
  ]);
  const after = await q1(env, `SELECT version FROM expenses WHERE id=?`, e.id);
  if (!after || after.version !== e.version + 1) throw conflict();
  const cancelledPending = await reconcilePending(env, m.dormitory_id, 'هزینه‌ای ویرایش شد و بدهی‌ها تغییر کرد');
  return { ok: true, cancelledPending };
}

async function route(env: Env, req: Request, path: string, uid: number, from: any) {
  const body = req.method === 'POST' ? await req.json().catch(() => { throw bad('درخواست نامعتبر است'); }) : {};
  const m = await me(env, uid);
  if ((path === '/api/dorm' || path === '/api/room/create') && req.method === 'POST') {
    await createDormitory(env, uid, from, str(body.name, 1, 80, 'نام اتاق'), body.requireConfirm !== false);
    return { ok: true };
  }
  if (path === '/api/room/switch' && req.method === 'POST') {
    if (!(await switchRoom(env, uid, String(body.id)))) throw new ApiError(404, 'not_found', 'اتاق پیدا نشد');
    return { ok: true };
  }
  if (path === '/api/room/delete' && req.method === 'POST') {
    const r = await deleteRoom(env, uid, String(body.id), String(body.confirm ?? ''));
    if (!r.ok) throw bad(r.error!);
    return { ok: true };
  }
  if (path === '/api/join' && req.method === 'POST') {
    const r = await joinWithCode(env, uid, from, String(body.code ?? ''));
    if (!r.ok) throw bad(r.error);
    return { ok: true };
  }
  if (!m) throw new ApiError(403, 'not_member', 'هنوز عضو هیچ خوابگاهی نیستید');
  const admin = () => { if (!isAdmin(m)) throw new ApiError(403, 'forbidden', 'فقط مدیر می‌تواند این کار را انجام دهد'); };

  if (path === '/api/state' && req.method === 'GET') return stateFor(env, m, uid);
  if (path === '/api/expense' && req.method === 'POST') return createExpense(env, m, body);
  if (path === '/api/expense/cancel' && req.method === 'POST') {
    const e = await q1(env, `SELECT id, created_by, status, version FROM expenses WHERE id=? AND dormitory_id=?`, String(body.id), m.dormitory_id);
    if (!e) throw new ApiError(404, 'not_found', 'هزینه پیدا نشد');
    if (e.created_by !== m.id && !isAdmin(m)) throw new ApiError(403, 'forbidden', 'فقط ثبت‌کننده یا مدیر می‌تواند هزینه را لغو کند');
    const reason = body.reason ? str(body.reason, 0, 200, 'دلیل') : null;
    const r = await env.DB.prepare(`UPDATE expenses SET status='cancelled', version=version+1, cancelled_by=?, cancel_reason=? WHERE id=? AND status='active' AND version=?`).bind(m.id, reason, e.id, Number(body.version)).run();
    if (!r.meta?.changes) throw new ApiError(409, 'conflict', 'این هزینه در این فاصله تغییر کرده است. صفحه را تازه کنید');
    await env.DB.prepare(`INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`).bind(m.dormitory_id, m.id, 'expense', e.id, 'cancel', JSON.stringify({ reason })).run();
    return { ok: true };
  }
  if (path === '/api/expense/update' && req.method === 'POST') return updateExpense(env, m, body);
  if (path === '/api/history/clear' && req.method === 'POST') {
    const r = await clearHistory(env, m);
    if (!r.ok) throw new ApiError(r.error.startsWith('فقط') ? 403 : 409, 'conflict', r.error);
    return r;
  }
  if (path === '/api/history/restore' && req.method === 'POST') {
    const r = await restoreHistory(env, m, String(body.id));
    if (!r.ok) throw new ApiError(r.error.startsWith('فقط') ? 403 : 404, 'not_found', r.error);
    return r;
  }
  if (path === '/api/room/settings' && req.method === 'POST') {
    if (!isAdmin(m)) throw new ApiError(403, 'forbidden', 'فقط مدیر می‌تواند تنظیمات اتاق را تغییر دهد');
    await env.DB.prepare(`UPDATE dormitories SET require_confirm=? WHERE id=?`).bind(body.requireConfirm === false ? 0 : 1, m.dormitory_id).run();
    return { ok: true };
  }
  if (path === '/api/settlement' && req.method === 'POST') {
    const r = await createPendingSettlement(env, m, String(body.from), String(body.to), Number(body.amount));
    if (!r.ok) throw new ApiError(r.error.startsWith('فقط') ? 403 : 409, 'conflict', r.error);
    return { ok: true, id: r.id, recipientNotified: r.recipientNotified, direct: r.direct };
  }
  if (path === '/api/settlement/respond' && req.method === 'POST') {
    const act = body.action === 'confirm' ? 'ok' : body.action === 'reject' ? 'no' : body.action === 'cancel' ? 'x' : null;
    if (!act) throw bad('عملیات نامعتبر است');
    const r = await respondSettlement(env, uid, String(body.id), act);
    if (!r.ok) throw new ApiError(409, 'conflict', r.message);
    return { ok: true, message: r.message };
  }
  if (path === '/api/me/profile' && req.method === 'POST') {
    const name = body.name !== undefined ? str(body.name, 1, 60, 'نام') : m.display_name;
    const nick = body.nick ? str(body.nick, 1, 30, 'نام مستعار') : null;
    await env.DB.prepare(`UPDATE members SET display_name=?, nickname=? WHERE id=?`).bind(name, nick, m.id).run();
    return { ok: true };
  }
  if (path === '/api/member/ids' && req.method === 'POST') {
    admin();
    const entries = parseIdEntries(String(body.text ?? ''));
    if (!entries.length) throw bad('آیدی عددی پیدا نشد (حداقل ۵ رقم)');
    return addMembersByIds(env, m, entries);
  }
  if (path === '/api/member/rename' && req.method === 'POST') {
    admin();
    const r = await env.DB.prepare(`UPDATE members SET display_name=? WHERE id=? AND dormitory_id=?`).bind(str(body.name, 1, 60, 'نام'), String(body.id), m.dormitory_id).run();
    if (!r.meta?.changes) throw new ApiError(404, 'not_found', 'عضو پیدا نشد');
    return { ok: true };
  }
  if (path === '/api/member' && req.method === 'POST') {
    admin();
    const name = str(body.name, 1, 60, 'نام');
    const id = crypto.randomUUID();
    await env.DB.batch([
      st(env, `INSERT INTO members(id,dormitory_id,display_name) VALUES(?,?,?)`, id, m.dormitory_id, name),
      st(env, `INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES(?,?,?,?,?,?)`, m.dormitory_id, m.id, 'member', id, 'create', JSON.stringify({ name })),
    ]);
    return { id };
  }
  if (path === '/api/member/deactivate' && req.method === 'POST') {
    admin();
    const t = await q1(env, `SELECT id, role FROM members WHERE id=? AND dormitory_id=? AND active=1`, String(body.id), m.dormitory_id);
    if (!t) throw new ApiError(404, 'not_found', 'عضو پیدا نشد');
    if (t.role === 'owner') throw bad('مدیر اصلی را نمی‌توان غیرفعال کرد');
    const { net } = await ledger(env, m.dormitory_id);
    if ((net.get(t.id) ?? 0) !== 0) throw bad('این عضو هنوز تراز غیرصفر دارد؛ اول تسویه کنید');
    await env.DB.prepare(`UPDATE members SET active=0 WHERE id=?`).bind(t.id).run();
    return { ok: true };
  }
  if (path === '/api/member/role' && req.method === 'POST') {
    if (m.role !== 'owner') throw new ApiError(403, 'forbidden', 'فقط مدیر اصلی می‌تواند نقش‌ها را تغییر دهد');
    const t = await q1(env, `SELECT id, role FROM members WHERE id=? AND dormitory_id=? AND active=1`, String(body.id), m.dormitory_id);
    if (!t || t.role === 'owner') throw bad('عضو نامعتبر است');
    const role = body.admin ? 'admin' : 'member';
    await env.DB.prepare(`UPDATE members SET role=? WHERE id=?`).bind(role, t.id).run();
    return { ok: true };
  }
  if (path === '/api/invite' && req.method === 'POST') {
    admin();
    let memberId: string | null = null;
    if (body.memberId) {
      const t = (await activeMembers(env, m.dormitory_id)).find((x) => x.id === body.memberId);
      if (!t || t.telegram_user_id) throw bad('این عضو معتبر نیست یا قبلاً وصل شده است');
      memberId = t.id;
    }
    return { code: await createInviteCode(env, m, memberId) };
  }
  if (path === '/api/export' && req.method === 'POST') {
    const s = await stateFor(env, m, uid);
    const nm = new Map(s.members.map((x) => [x.id, x.name]));
    const rows: any[][] = [['تاریخ', 'شرح', 'دسته', 'پرداخت‌کننده', 'مبلغ (تومان)', 'روش', 'وضعیت', 'سهم‌ها']];
    for (const e of s.expenses) rows.push([e.date, e.desc, e.category ?? '', nm.get(e.payer) ?? '', e.total / SCALE, e.method === 'equal' ? 'مساوی' : 'سفارشی', e.status === 'active' ? 'فعال' : 'لغو‌شده', e.allocs.map((a: any) => `${nm.get(a.m)}:${a.a / SCALE}`).join(' | ')]);
    rows.push([], ['تراز اعضا']);
    for (const mm of s.members) rows.push([mm.name, (s.balances[mm.id] ?? 0) / SCALE]);
    const fd = new FormData();
    fd.append('chat_id', String(uid));
    fd.append('caption', `گزارش خوابگاه «${s.dorm.name}»`);
    fd.append('document', new Blob([buildCsv(rows)], { type: 'text/csv; charset=utf-8' }), 'dormledger.csv');
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
    if (!r.ok) throw new ApiError(502, 'telegram', 'ارسال فایل به تلگرام انجام نشد');
    return { ok: true };
  }
  throw new ApiError(404, 'not_found', 'یافت نشد');
}

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const cid = crypto.randomUUID().slice(0, 8);
  const path = new URL(req.url).pathname;
  try {
    const user = await validateInitData(req.headers.get('X-Telegram-Init-Data') ?? '', env.BOT_TOKEN, Number(env.INITDATA_MAX_AGE ?? 86400));
    if (!user) return json({ error: 'unauthorized', message: 'برنامه را از داخل تلگرام باز کنید' }, 401);
    if (rateLimited('u' + user.id)) return json({ error: 'rate_limited', message: 'درخواست‌ها زیاد است؛ کمی صبر کنید' }, 429);
    return json(await route(env, req, path, user.id, user));
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.code, message: e.message }, e.status);
    console.log(JSON.stringify({ evt: 'api_error', cid, path, msg: String((e as Error)?.message).slice(0, 200) }));
    return json({ error: 'server', message: 'خطای داخلی. دوباره تلاش کنید', cid }, 500);
  }
}
