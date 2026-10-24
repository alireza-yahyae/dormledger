# Contributing

1. Use Node.js 22.13 or newer.
2. `npm test` runs the whole suite (no dependencies required).
3. The Mini App source of truth is `ui/index.html`. After editing it run `npm run build:ui` to regenerate `src/ui.ts` and commit both (CI checks they match).
4. Database changes go in a new numbered file in `migrations/` – never edit an already-released migration.
5. Amounts are stored as integers in **hundredths of a toman**; keep all money math in integers.

6. `python scripts/release_to_github.py` publishes the project to your own GitHub repository (browser sign-in, version tag, GitHub Release from `CHANGELOG.md`). It never copies tokens, `wrangler.jsonc` or database backups. Try `--dry-run` first.
7. `scripts/install.ps1` is the one-line installer/updater. It must stay plain ASCII and work in Windows PowerShell 5.1 (no `??`, `?.`, `&&`, ternary).
8. The README pictures are generated: `node --experimental-strip-types --no-warnings scripts/screenshots/build_sample.mjs`, then `capture_bot.mjs`, then `python scripts/screenshots/shoot.py` (needs `pip install playwright`). They use invented sample data only.
9. Add an entry to `CHANGELOG.md` and bump `version` in `package.json` for a release.
