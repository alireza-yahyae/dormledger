import { buildCsv } from './csv.ts';
import { computeBalances } from './domain/ledger.ts';
import { SCALE } from './domain/money.ts';

/** Data tables, parent tables first, so the dump can be replayed with foreign keys on. Transient tables (bot_state, processed_updates, idempotency_keys) are skipped on purpose. */
export const BACKUP_TABLES = ['dormitories', 'members', 'invitations', 'expense_categories', 'expenses', 'expense_allocations', 'settlements', 'audit_events', 'settings', 'user_prefs', 'member_requests', 'archives', 'archived_expenses', 'archived_allocations', 'archived_settlements'];
const PAGE = 1000;

function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) { const b = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength); return "X'" + [...b].map((x) => x.toString(16).padStart(2, '0')).join('') + "'"; }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** A plain SQL file of INSERTs. Restore: create the DB, apply the migrations, then `wrangler d1 execute dormledger --remote --file=backup.sql`. */
export async function buildBackupSql(env: any, now = new Date()): Promise<{ sql: string; rows: number }> {
  const out: string[] = [`-- DormLedger backup ${now.toISOString()}`, '-- Data only. Restore into a database that already has the migrations applied.'];
  let rows = 0;
  for (const t of BACKUP_TABLES) {
    for (let off = 0; ; off += PAGE) {
      const page: any[] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid LIMIT ${PAGE} OFFSET ${off}`).all()).results;
      for (const r of page) { const k = Object.keys(r); out.push(`INSERT INTO ${t}(${k.join(',')}) VALUES(${k.map((c) => lit(r[c])).join(',')});`); rows++; }
      if (page.length < PAGE) break;
    }
  }
  return { sql: out.join('\n') + '\n', rows };
}

/** A spreadsheet anyone can open on a phone (Google Sheets / Excel): balances, every expense and confirmed payment of every live room. */
export async function buildReportCsv(env: any): Promise<string> {
  const q = async (sql: string, ...a: unknown[]): Promise<any[]> => (await env.DB.prepare(sql).bind(...a).all()).results;
  const bal: any[][] = [['اتاق', 'عضو', 'تراز (تومان)']];
  const exp: any[][] = [['اتاق', 'تاریخ', 'شرح', 'دسته', 'پرداخت‌کننده', 'مبلغ (تومان)', 'وضعیت', 'سهم‌ها']];
  const set: any[][] = [['اتاق', 'تاریخ', 'از', 'به', 'مبلغ (تومان)']];
  for (const d of await q(`SELECT id, name FROM dormitories WHERE deleted_at IS NULL ORDER BY rowid`)) {
    const ms = await q(`SELECT id, display_name, active FROM members WHERE dormitory_id=? ORDER BY rowid`, d.id);
    const nm = new Map<string, string>(ms.map((m) => [m.id, m.display_name]));
    const es = await q(`SELECT id, description, category, total_amount, payer_id, expense_date, status FROM expenses WHERE dormitory_id=? ORDER BY expense_date, rowid`, d.id);
    const al = await q(`SELECT a.expense_id, a.member_id, a.amount FROM expense_allocations a JOIN expenses e ON e.id=a.expense_id WHERE e.dormitory_id=?`, d.id);
    const ss = await q(`SELECT from_member_id, to_member_id, amount, settled_on FROM settlements WHERE dormitory_id=? AND status='confirmed' ORDER BY settled_on, rowid`, d.id);
    const by = new Map<string, { memberId: string; amount: number }[]>();
    for (const a of al) { if (!by.has(a.expense_id)) by.set(a.expense_id, []); by.get(a.expense_id)!.push({ memberId: a.member_id, amount: a.amount }); }
    const net = computeBalances(ms.map((m) => m.id), es.filter((e) => e.status === 'active').map((e) => ({ id: e.id, total: e.total_amount, payerId: e.payer_id, allocations: by.get(e.id) ?? [], status: 'active' as const })), ss.map((x, i) => ({ id: String(i), fromId: x.from_member_id, toId: x.to_member_id, amount: x.amount, status: 'confirmed' as const })));
    for (const m of ms) if (m.active || (net.get(m.id) ?? 0) !== 0) bal.push([d.name, m.display_name, (net.get(m.id) ?? 0) / SCALE]);
    for (const e of es) exp.push([d.name, e.expense_date, e.description, e.category ?? '', nm.get(e.payer_id) ?? '', e.total_amount / SCALE, e.status === 'active' ? 'فعال' : 'لغو‌شده', (by.get(e.id) ?? []).map((a) => `${nm.get(a.memberId) ?? '؟'}:${a.amount / SCALE}`).join(' | ')]);
    for (const x of ss) set.push([d.name, x.settled_on, nm.get(x.from_member_id) ?? '', nm.get(x.to_member_id) ?? '', x.amount / SCALE]);
  }
  return buildCsv([...bal, [], ...exp, [], ...set]);
}

async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

export type BackupResult = { ok: boolean; name?: string; report?: string; bytes?: number; rows?: number; channels: string[]; errors: string[]; skipped?: string };

/**
 * Daily backup (called from the cron trigger). Destinations, either or both:
 *  - BACKUP_CHAT_ID: the .sql.gz is sent as a document to that Telegram chat (use your own private chat; the file holds real user data)
 *  - BACKUP R2 bucket binding: stored as dormledger-YYYY-MM-DD.sql.gz, the newest BACKUP_KEEP (default 14) are kept
 */
/**
 * Daily backup (called from the cron trigger). Two files per run:
 *  - dormledger-YYYY-MM-DD.sql.gz  : the full data, restorable (see README "Backups")
 *  - dormledger-YYYY-MM-DD-report.csv : a readable spreadsheet of balances and expenses, usable on a phone with no bot at all
 * Destinations, either or both:
 *  - BACKUP_CHAT_ID: both files are sent to that Telegram chat (use your own private chat; the files hold real user data).
 *    Sent with BACKUP_BOT_TOKEN when set (a second, private bot), so a banned main bot does not stop your backups.
 *  - BACKUP R2 bucket binding: stored under the same names, the newest BACKUP_KEEP (default 14) of each kind are kept
 */
export async function runBackup(env: any, now = new Date()): Promise<BackupResult> {
  const chat = env.BACKUP_CHAT_ID ? String(env.BACKUP_CHAT_ID) : '', bucket = env.BACKUP;
  const token = String(env.BACKUP_BOT_TOKEN || env.BOT_TOKEN || '');
  const res: BackupResult = { ok: false, channels: [], errors: [] };
  if (!chat && !bucket) { res.skipped = 'no backup destination configured (set BACKUP_CHAT_ID and/or an R2 binding named BACKUP)'; console.log(JSON.stringify({ evt: 'backup_skipped' })); return res; }
  const send = async (name: string, body: Blob, caption: string) => {
    const fd = new FormData();
    fd.append('chat_id', chat); fd.append('caption', caption); fd.append('document', body, name);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  };
  try {
    const { sql, rows } = await buildBackupSql(env, now);
    const data = await gzip(sql), day = now.toISOString().slice(0, 10);
    res.name = `dormledger-${day}.sql.gz`; res.report = `dormledger-${day}-report.csv`; res.bytes = data.length; res.rows = rows;
    let report = '';
    try { report = await buildReportCsv(env); } catch (e) { res.errors.push('report: ' + String((e as Error)?.message).slice(0, 120)); }
    if (bucket) {
      try {
        await bucket.put(res.name, data, { httpMetadata: { contentType: 'application/gzip' } });
        if (report) await bucket.put(res.report, report, { httpMetadata: { contentType: 'text/csv; charset=utf-8' } });
        const keep = Math.max(1, Number(env.BACKUP_KEEP ?? 14));
        const keys = ((await bucket.list({ prefix: 'dormledger-' })).objects as { key: string }[]).map((o) => o.key).sort();
        for (const suffix of ['.sql.gz', '-report.csv']) { const g = keys.filter((k) => k.endsWith(suffix)); for (const k of g.slice(0, Math.max(0, g.length - keep))) await bucket.delete(k); }
        res.channels.push('R2');
      } catch (e) { res.errors.push('R2: ' + String((e as Error)?.message).slice(0, 120)); }
    }
    if (chat) {
      if (data.length > 49 * 1024 * 1024) res.errors.push('Telegram: file is over 50 MB, use an R2 bucket');
      else {
        try {
          await send(res.name, new Blob([data as BlobPart], { type: 'application/gzip' }), `DormLedger backup ${res.name} · ${rows} rows`);
          if (report) await send(res.report, new Blob([report], { type: 'text/csv; charset=utf-8' }), 'گزارش قابل‌خواندن (برای گوگل‌شیت/اکسل)');
          res.channels.push('Telegram');
        } catch (e) { res.errors.push('Telegram: ' + String((e as Error)?.message).slice(0, 120)); }
      }
    }
  } catch (e) { res.errors.push('dump: ' + String((e as Error)?.message).slice(0, 120)); }
  res.ok = res.channels.length > 0 && res.errors.length === 0;
  console.log(JSON.stringify({ evt: res.ok ? 'backup_ok' : 'backup_failed', name: res.name, bytes: res.bytes, channels: res.channels, errors: res.errors }));
  if (res.errors.length && chat) {
    try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: '⚠️ بکاپ روزانه‌ی DormLedger کامل انجام نشد:\n' + res.errors.join('\n') }) }); } catch { /* nothing more to do */ }
  }
  return res;
}
