# Contributing

1. Use Node.js 22.13 or newer.
2. `npm test` runs the whole suite (no dependencies required).
3. The Mini App source of truth is `ui/index.html`. After editing it run `npm run build:ui` to regenerate `src/ui.ts` and commit both (CI checks they match).
4. Database changes go in a new numbered file in `migrations/` – never edit an already-released migration.
5. Amounts are stored as integers in **hundredths of a toman**; keep all money math in integers.

6. `python scripts/publish_to_github.py` publishes a fresh copy of the project to your own GitHub account (it refuses to upload tokens, `wrangler.jsonc` or database backups).
