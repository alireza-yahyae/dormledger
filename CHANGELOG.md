# Changelog

All notable changes to DormLedger. Versions follow [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-10-24

### Added
- **Guest members (عضو مهمان).** An admin can mark any active member - even themself - as a guest, in the Mini App (the
  «مهمان» chip in the Members tab) or in the bot (`/guests`). When an expense is added, main members are ticked by default
  and guests sit in a separate box, unticked - except a guest who is the **payer**, who is ticked automatically. Whoever
  records the expense can still tick or untick anyone. It only changes the default selection, never balances or old
  expenses. (Migration `0009_substitute_members.sql`, endpoint `POST /api/member/substitute`.)
- **One-line installer for PowerShell** (`scripts/install.ps1`): installs missing tools, logs you in to Cloudflare through
  the browser, creates the database, deploys, stores the secrets and connects the Telegram bot. Run it again to update.
- **Release helper** (`scripts/release_to_github.py`, replaces `publish_to_github.py`): publishes the project to GitHub with a
  browser sign-in, tags the version and creates the GitHub Release from this changelog.
- New README (English + Persian) with screenshots of the Mini App **and of the bot chat**, and a screenshot generator
  (`scripts/screenshots/`) that renders them from the real code with invented sample data.

### Fixed
- **Settling up inside the bot.** Pressing «تسویه حساب» in the chat showed no payment options for people who do not use the
  Mini App. Cause: the payment button's `callback_data` was 87 bytes and Telegram rejects anything over 64 bytes, so the
  buttons were never sent. They are now short (`pay:<to>:<amount>`), and the chat explains what to do:
  - a debtor gets a «پرداخت کردم» button per transfer,
  - a creditor is told to wait for the debtor's message and confirm it,
  - an admin can confirm / reject a pending payment on behalf of a creditor who has no Telegram account linked.
- A stranger pressing someone else's payment button can no longer record more than they owe.

### Changed
- The "who shares this expense?" keyboard shows main members, then the guest block, then
  «همه | پیش‌فرض | هیچ‌کس» and a Persian-digit counter.
- Tests: 53 (was 28), the Telegram mock now enforces the 64-byte `callback_data` limit like the real API.

### Upgrading from 1.x
```powershell
irm https://raw.githubusercontent.com/alireza-yahyae/dormledger/main/scripts/install.ps1 | iex
```
or, by hand: `git pull`, `npm install`, `npm run migrate:remote` (applies `0009`), `npm run deploy`, then open
`/setup?key=<WEBHOOK_SECRET>` once so the bot menu gets the new `/guests` command. Existing data is untouched.

## [1.0.0] - 2026-10-12
- First version: rooms, members, equal/custom splits, balances, settlements, backups, Telegram bot and Mini App.
