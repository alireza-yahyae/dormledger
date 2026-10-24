import { handleUpdate, purgeExpiredArchives, purgeOldRequests } from './bot.ts';
import { runBackup } from './backup.ts';
import { handleApi } from './api.ts';
import { HTML } from './ui.ts';
import { tg } from './tg.ts';

const safeEq = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export default {
  // daily: purge cleared histories older than 48 hours and stale join requests, then take the backup
  async scheduled(_event: unknown, env: any, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil((async () => {
      for (const job of [() => purgeExpiredArchives(env), () => purgeOldRequests(env)]) { try { await job(); } catch (e) { console.log(JSON.stringify({ evt: 'cron_error', msg: String((e as Error)?.message).slice(0, 200) })); } }
      await runBackup(env);
    })());
  },
  async fetch(req: Request, env: any, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, ctx);
    if (url.pathname === '/' || url.pathname === '/index.html') return new Response(HTML, { headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://*.telegram.org" } });
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/setup' && req.method === 'GET') {
      if (!env.WEBHOOK_SECRET || !safeEq(url.searchParams.get('key') ?? '', env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
      const base = typeof env.APP_URL === 'string' && /^https:\/\//i.test(env.APP_URL) ? env.APP_URL.replace(/\/+$/, '') : url.origin;
      const call = async (m: string, b: unknown) => (await tg(env, m, b)).json();
      const commands = [['start', 'شروع'], ['app', 'باز کردن برنامه'], ['add', 'ثبت هزینه'], ['balance', 'تراز'], ['settle', 'تسویه حساب'], ['expenses', 'هزینه‌ها'], ['members', 'اعضا'], ['guests', 'اعضای مهمان'], ['rooms', 'اتاق‌ها'], ['name', 'تغییر نام من'], ['nickname', 'نام مستعار من'], ['leave', 'ترک اتاق'], ['clearhistory', 'پاک کردن تاریخچه'], ['restorehistory', 'بازگردانی تاریخچه'], ['help', 'راهنما'], ['cancel', 'انصراف']].map(([command, description]) => ({ command, description }));
      return Response.json({
        webhook: await call('setWebhook', { url: base + '/webhook', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] }),
        menu: await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'DormLedger', web_app: { url: base + '/' } } }),
        commands: await call('setMyCommands', { commands }),
      });
    }
    if (url.pathname === '/webhook' && req.method === 'POST') {
      const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
      if (!env.WEBHOOK_SECRET || !safeEq(secret, env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
      let update: any;
      try { update = await req.json(); } catch { return new Response('bad request', { status: 400 }); }
      try { await handleUpdate(env, update, ctx); } catch (e) { console.log(JSON.stringify({ evt: 'update_error', id: update?.update_id, msg: String((e as Error)?.message).slice(0, 200) })); }
      return new Response('ok'); // always 200 so Telegram does not retry-storm
    }
    return new Response('not found', { status: 404 });
  },
};
