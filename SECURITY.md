# Security

- Please **do not** open a public issue for security problems. Use GitHub's *Report a vulnerability* (Security tab → Advisories) instead.
- Never commit your bot token, `WEBHOOK_SECRET`, `.dev.vars`, `wrangler.jsonc`, or database exports. They are listed in `.gitignore`.
- If a bot token ever leaks, revoke it in @BotFather (`/revoke`) and update the secret with `npx wrangler secret put BOT_TOKEN`.
- The Mini App API only accepts requests carrying Telegram-signed `initData` that is validated server-side (HMAC with the bot token, freshness-checked).
