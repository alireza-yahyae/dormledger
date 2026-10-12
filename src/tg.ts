export async function tg(env: any, method: string, body: unknown): Promise<Response> {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) console.log(JSON.stringify({ evt: 'tg_error', method, status: r.status }));
  return r;
}
