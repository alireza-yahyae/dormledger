import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import worker from '../../src/index.ts';
import { buildBackupSql, runBackup, BACKUP_TABLES } from '../../src/backup.ts';

const MIGRATIONS = readdirSync(new URL('../../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of MIGRATIONS) db.exec(readFileSync(new URL('../../migrations/' + f, import.meta.url), 'utf8'));
  const mk = (sql: string, params: unknown[] = []) => ({
    bind: (...a: unknown[]) => mk(sql, a),
    first: async () => db.prepare(sql).get(...(params as any[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as any[])) }),
    run: async () => { const r = db.prepare(sql).run(...(params as any[])); return { meta: { changes: Number(r.changes) } }; },
  });
  return { raw: db, prepare: (s: string) => mk(s) };
}

// Telegram mock: records sendDocument uploads and plain messages. `telegramStatus` lets a test make it fail.
const docs: { chat: string; name: string; bytes: Buffer; caption: string; url: string }[] = [], msgs: any[] = [];
let telegramStatus = 200;
globalThis.fetch = (async (url: string, init: any) => {
  if (telegramStatus !== 200) return new Response('{"ok":false}', { status: telegramStatus });
  if (init.body instanceof FormData) {
    const f = init.body as FormData, file = f.get('document') as File;
    docs.push({ chat: String(f.get('chat_id')), name: file.name, bytes: Buffer.from(await file.arrayBuffer()), caption: String(f.get('caption')), url: String(url) });
  } else msgs.push({ ...JSON.parse(init.body), url: String(url) });
  return new Response('{"ok":true}');
}) as any;

/** Minimal in-memory R2 bucket. */
const fakeR2 = () => { const m = new Map<string, Uint8Array>(); return { m, put: async (k: string, v: Uint8Array) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); }, list: async ({ prefix }: { prefix: string }) => ({ objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }) }; };

function seed(db: DatabaseSync) {
  const x = (q: string, ...a: any[]) => db.prepare(q).run(...a);
  x(`INSERT INTO dormitories(id,name) VALUES('d1', ?)`, "اتاق «۲۰۴» it's \"quoted\"\nsecond line 😀");
  x(`INSERT INTO members(id,dormitory_id,display_name,telegram_user_id,role,nickname) VALUES('m1','d1','علی',111,'owner',NULL),('m2','d1','O''Brien',222,'member','ابو')`);
  x(`INSERT INTO expenses(id,dormitory_id,description,total_amount,payer_id,method,expense_date,created_by,category,notes) VALUES('e1','d1','نان; DROP TABLE x;--',10000100,'m1','equal','2026-10-10','m1','غذا',NULL)`);
  x(`INSERT INTO expense_allocations VALUES('e1','m1',5000050),('e1','m2',5000050)`);
  x(`INSERT INTO settlements(id,dormitory_id,from_member_id,to_member_id,amount,settled_on,status,recorded_by) VALUES('d1:settle:0','d1','m2','m1',5000000,'2026-10-11','confirmed','m2')`);
  x(`INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action,after_json) VALUES('d1','m1','expense','e1','create','{"a":"it''s"}')`);
  x(`INSERT INTO user_prefs VALUES(111,'d1')`);
  x(`INSERT INTO settings VALUES('d1','k','v')`);
  x(`INSERT INTO member_requests(id,dormitory_id,telegram_user_id,name,created_by,expires_at) VALUES('r1','d1',333,'سارا','m1','2099-01-01T00:00:00.000Z')`);
  // transient tables must NOT be dumped
  x(`INSERT INTO bot_state(telegram_user_id,state) VALUES(1,'{}')`); x(`INSERT INTO processed_updates(update_id) VALUES(1)`);
}
const dump = (db: DatabaseSync, t: string) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();

test('backup SQL restores into a fresh database identically (quotes, newlines, Persian, emoji, NULLs, FK order)', async () => {
  const env: any = { DB: makeDb() }; seed(env.DB.raw);
  const { sql, rows } = await buildBackupSql(env, new Date('2026-10-14T03:17:00Z'));
  assert.equal(rows, 11, 'exactly the seeded data rows (1+2+1+2+1+1+1+1+1)');
  assert.match(sql, /^-- DormLedger backup 2026-10-14T03:17:00.000Z/);
  assert.ok(!/bot_state|processed_updates|idempotency_keys/.test(sql), 'transient tables are skipped');
  const fresh = makeDb(); fresh.raw.exec(sql); // foreign keys are ON: parents must come first
  for (const t of BACKUP_TABLES) assert.deepEqual(dump(fresh.raw, t), dump(env.DB.raw, t), t + ' round-trips');
  assert.equal((fresh.raw.prepare(`SELECT name FROM dormitories`).get() as any).name, (env.DB.raw.prepare(`SELECT name FROM dormitories`).get() as any).name);
  assert.equal((fresh.raw.prepare(`SELECT COUNT(*) n FROM bot_state`).get() as any).n, 0);
});

test('backup pages through large tables (more than one page of rows)', async () => {
  const env: any = { DB: makeDb() }; env.DB.raw.exec(`INSERT INTO dormitories(id,name) VALUES('d','x'); INSERT INTO members(id,dormitory_id,display_name,role) VALUES('m','d','a','owner')`);
  env.DB.raw.exec('BEGIN'); for (let i = 0; i < 2500; i++) env.DB.raw.prepare(`INSERT INTO audit_events(dormitory_id,actor_id,entity,entity_id,action) VALUES('d','m','e',?,'c')`).run('id' + i); env.DB.raw.exec('COMMIT');
  const { sql } = await buildBackupSql(env);
  const fresh = makeDb(); fresh.raw.exec(sql);
  assert.equal((fresh.raw.prepare(`SELECT COUNT(*) n FROM audit_events`).get() as any).n, 2500);
});

test('runBackup: nothing configured -> skipped, not an error', async () => {
  const r = await runBackup({ DB: makeDb() });
  assert.equal(r.ok, false); assert.match(r.skipped!, /no backup destination/); assert.deepEqual(r.errors, []);
  assert.equal(docs.length, 0);
});

test('runBackup -> Telegram: a gzip of the SQL arrives in the chosen chat', async () => {
  const env: any = { DB: makeDb(), BOT_TOKEN: 't', BACKUP_CHAT_ID: '5550001' }; seed(env.DB.raw);
  docs.length = 0;
  const r = await runBackup(env, new Date('2026-10-14T03:17:00Z'));
  assert.equal(r.ok, true); assert.deepEqual(r.channels, ['Telegram']);
  assert.deepEqual(docs.map((d) => d.name), ['dormledger-2026-10-14.sql.gz', 'dormledger-2026-10-14-report.csv'], 'restorable dump + readable report');
  assert.equal(docs[0].chat, '5550001'); assert.match(docs[0].caption, /rows/);
  const sql = gunzipSync(docs[0].bytes).toString('utf8');
  const fresh = makeDb(); fresh.raw.exec(sql);
  assert.deepEqual(dump(fresh.raw, 'expenses'), dump(env.DB.raw, 'expenses'), 'the delivered file really restores');
});

test('runBackup -> R2: daily object, only the newest BACKUP_KEEP are kept', async () => {
  const r2 = fakeR2(), env: any = { DB: makeDb(), BACKUP: r2, BACKUP_KEEP: '3' }; seed(env.DB.raw);
  for (const d of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']) assert.equal((await runBackup(env, new Date(d + 'T03:17:00Z'))).ok, true);
  assert.deepEqual([...r2.m.keys()].sort(), ['12', '13', '14'].flatMap((d) => [`dormledger-2026-10-${d}-report.csv`, `dormledger-2026-10-${d}.sql.gz`]), 'newest 3 of EACH kind');
  r2.m.set('unrelated.txt', new Uint8Array()); await runBackup(env, new Date('2026-10-15T03:17:00Z'));
  assert.ok(r2.m.has('unrelated.txt'), 'objects outside the prefix are never touched');
  // same day twice overwrites instead of duplicating
  await runBackup(env, new Date('2026-10-15T09:00:00Z')); assert.equal([...r2.m.keys()].filter((k) => k.includes('10-15')).length, 2, 'one dump + one report');
});

test('runBackup: both destinations; a failing one is reported, the other still succeeds, owner is warned', async () => {
  const bad = { put: async () => { throw new Error('R2 is down'); }, list: async () => ({ objects: [] }), delete: async () => {} };
  const env: any = { DB: makeDb(), BOT_TOKEN: 't', BACKUP_CHAT_ID: '5550001', BACKUP: bad }; seed(env.DB.raw);
  docs.length = 0; msgs.length = 0;
  const r = await runBackup(env);
  assert.equal(r.ok, false); assert.deepEqual(r.channels, ['Telegram']); assert.match(r.errors[0], /R2 is down/);
  assert.equal(docs.length, 2, 'Telegram copies still sent');
  assert.ok(msgs.some((m) => m.chat_id === '5550001' && /بکاپ روزانه/.test(m.text)), 'owner gets a warning message');
});

test('runBackup: Telegram failure is an error, never an exception', async () => {
  const env: any = { DB: makeDb(), BOT_TOKEN: 't', BACKUP_CHAT_ID: '5550001' }; seed(env.DB.raw);
  telegramStatus = 500;
  try { const r = await runBackup(env); assert.equal(r.ok, false); assert.match(r.errors[0], /HTTP 500/); } finally { telegramStatus = 200; }
});

test('cron: scheduled() purges, then backs up once a day', async () => {
  const r2 = fakeR2(), env: any = { DB: makeDb(), BACKUP: r2 }; seed(env.DB.raw);
  env.DB.raw.exec(`INSERT INTO member_requests(id,dormitory_id,telegram_user_id,name,created_by,expires_at,created_at) VALUES('old','d1',444,'x','m1','2020-01-01T00:00:00.000Z','2020-01-01 00:00:00')`);
  const jobs: Promise<unknown>[] = [];
  await (worker as any).scheduled({}, env, { waitUntil: (p: Promise<unknown>) => jobs.push(p) });
  await Promise.all(jobs);
  assert.equal(r2.m.size, 2, 'dump and report were written');
  assert.equal((env.DB.raw.prepare(`SELECT COUNT(*) n FROM member_requests WHERE id='old'`).get() as any).n, 0, 'stale join requests purged');
  assert.equal((env.DB.raw.prepare(`SELECT COUNT(*) n FROM member_requests WHERE id='r1'`).get() as any).n, 1, 'fresh ones kept');
  // a crash in cleanup must not stop the backup
  const jobs2: Promise<unknown>[] = [], env2: any = { DB: { prepare: () => { throw new Error('boom'); } }, BACKUP: fakeR2() };
  await (worker as any).scheduled({}, env2, { waitUntil: (p: Promise<unknown>) => jobs2.push(p) }); await Promise.all(jobs2);
});

test('the readable report: every room, balances and expenses, numbers stay numbers, text is escaped', async () => {
  const env: any = { DB: makeDb() }; seed(env.DB.raw);
  env.DB.raw.exec(`INSERT INTO dormitories(id,name,deleted_at) VALUES('gone','اتاق حذف‌شده','2026-01-01T00:00:00Z')`);
  const { buildReportCsv } = await import('../../src/backup.ts');
  const csv = await buildReportCsv(env);
  assert.ok(csv.startsWith('\uFEFF'), 'BOM so Excel and Sheets read Persian correctly');
  assert.ok(!csv.includes('حذف‌شده'), 'deleted rooms are left out');
  assert.match(csv, /,O'Brien,-0\.5\r\n/, 'a negative balance is a real number (A1), in toman');
  assert.match(csv, /,علی,0\.5\r\n/);
  assert.match(csv, /"نان; DROP TABLE x;--"|نان; DROP TABLE x;--/, 'expense row is present');
  assert.match(csv, /100001/, 'total in toman, not hundredths');
  assert.match(csv, /"اتاق «۲۰۴» it's ""quoted""\nsecond line 😀"/, 'quotes and newlines are CSV-escaped');
  assert.match(csv, /علی:50000\.5 \| O'Brien:50000\.5/, 'shares listed per person');
  assert.match(csv, /2026-10-11,O'Brien,علی,50000/, 'confirmed payment listed');
});

test('a broken report never blocks the real backup', async () => {
  const env: any = { DB: makeDb(), BOT_TOKEN: 't', BACKUP_CHAT_ID: '5550001' }; seed(env.DB.raw);
  env.DB.raw.exec(`UPDATE expenses SET total_amount=999 WHERE id='e1'`); // shares no longer add up -> the report cannot be computed
  docs.length = 0; msgs.length = 0;
  const r = await runBackup(env);
  assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.startsWith('report:')), 'the problem is reported');
  assert.deepEqual(docs.map((d) => d.name), ['dormledger-' + new Date().toISOString().slice(0, 10) + '.sql.gz'], 'the dump itself was still delivered');
  assert.ok(msgs.some((m) => /بکاپ روزانه/.test(m.text)), 'owner is warned');
});

test('BACKUP_BOT_TOKEN: a second bot sends the backups, so a banned main bot cannot stop them', async () => {
  const env: any = { DB: makeDb(), BOT_TOKEN: 'MAINBOT:aaa', BACKUP_BOT_TOKEN: 'SECOND:bbb', BACKUP_CHAT_ID: '5550001' }; seed(env.DB.raw);
  docs.length = 0;
  assert.equal((await runBackup(env)).ok, true);
  assert.ok(docs.length === 2 && docs.every((d) => d.url.includes('/botSECOND:bbb/')), 'both files go through the backup bot');
  docs.length = 0; delete env.BACKUP_BOT_TOKEN;
  await runBackup(env); assert.ok(docs.every((d) => d.url.includes('/botMAINBOT:aaa/')), 'falls back to the main bot');
});
