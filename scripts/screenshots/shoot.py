#!/usr/bin/env python3
"""
Renders the README pictures.

  1. Mini App screens: the REAL ui/index.html in headless Chromium, fed with scripts/screenshots/sample-state.json
     (made-up people and amounts; balances and the settlement plan come from the real domain code).
  2. Bot chats: scripts/screenshots/bot-chats.json holds what the REAL bot code sent in a few conversations
     (see capture_bot.mjs); here it is only drawn as a chat.
  3. docs/social-preview.png: the repository banner built from the pictures above.

Regenerate everything (needs Python + `pip install playwright` + a Chromium that Playwright can find):

    node --experimental-strip-types --no-warnings scripts/screenshots/build_sample.mjs
    node --experimental-strip-types --no-warnings scripts/screenshots/capture_bot.mjs
    python scripts/screenshots/shoot.py
"""
import html
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
IMG = ROOT / "docs" / "img"
IMG.mkdir(parents=True, exist_ok=True)

APP_HTML = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
STATE = (HERE / "sample-state.json").read_text(encoding="utf-8")
CHATS = json.loads((HERE / "bot-chats.json").read_text(encoding="utf-8"))

TELEGRAM_STUB = """
window.Telegram = { WebApp: { initData: 'sample', ready() {}, expand() {}, colorScheme: 'dark',
  BackButton: { onClick() {}, show() {}, hide() {} } } };
"""


# ------------------------------------------------------------------ Mini App
def app_shots(browser):
    page = browser.new_page(viewport={"width": 390, "height": 780}, device_scale_factor=2, color_scheme="dark", locale="fa-IR")
    page.add_init_script(TELEGRAM_STUB)
    page.route("**/telegram-web-app.js", lambda r: r.abort())
    page.route("http://dormledger.local/", lambda r: r.fulfill(status=200, content_type="text/html; charset=utf-8", body=APP_HTML))
    page.route("**/api/state", lambda r: r.fulfill(status=200, content_type="application/json", body=STATE))
    page.goto("http://dormledger.local/")
    page.wait_for_selector("nav button")
    page.wait_for_timeout(300)

    def shot(name):
        page.wait_for_timeout(250)
        page.screenshot(path=str(IMG / name))
        print("wrote", name)

    def tab(t):
        page.evaluate(f"A.tab({{dataset:{{t:'{t}'}}}})")

    tab("home"); shot("01-home.png")
    tab("exp"); shot("02-expenses.png")
    page.evaluate("A.exp({dataset:{id:'e4'}})"); shot("03-expense-detail.png")  # the cinema: a guest paid, so the guest is in
    page.evaluate("closeLayer()")
    tab("settle"); shot("04-settle.png")
    tab("members"); shot("05-members.png")

    # a new expense: main members ticked, guests in their own box, unticked
    page.evaluate("A.add({}); F.amount='480000'; F.desc='پیتزا شب جمعه'; F.cat='غذا'; F.payer='m-reza'; F.sel=defSel('m-reza'); showForm();")
    page.evaluate("document.querySelector('.seg').scrollIntoView({block:'start'})")
    shot("06-add-expense.png")
    # the guest pays: the guest is ticked
    page.evaluate("A.fpay({dataset:{id:'m-nima'}});")
    page.evaluate("document.querySelector('.chips').scrollIntoView({block:'start'}); document.querySelector('#fbody').scrollTop += 150;")
    page.evaluate("document.querySelector('[data-a=fpay]').closest('.field').scrollIntoView({block:'start'})")
    shot("07-guest-payer.png")
    page.close()


# ------------------------------------------------------------------ bot chat (drawn from the real captured messages)
CHAT_CSS = """
*{box-sizing:border-box;margin:0}
body{width:390px;background:#0b141d;font-family:'DejaVu Sans',system-ui,sans-serif;color:#e8eef3;direction:rtl}
.top{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#111c27;border-bottom:1px solid #1d2c3a;direction:ltr}
.av{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#1d4558,#2f8aa1);display:grid;place-items:center;font-weight:700;color:#fff}
.nm{font-weight:700;font-size:15px}.sub{font-size:12px;color:#7d92a3}
.chat{direction:ltr;padding:14px 12px 18px;display:flex;flex-direction:column;gap:10px;background:
  radial-gradient(900px 400px at 100% -10%,rgba(47,138,161,.10),transparent 60%),#0b141d}
.row{display:flex;flex-direction:column;max-width:88%}
.row.bot{align-self:flex-start;align-items:stretch}.row.user{align-self:flex-end}
.b{direction:rtl;padding:9px 12px;border-radius:14px;font-size:14.5px;line-height:1.75;white-space:pre-wrap;text-align:right;unicode-bidi:plaintext}
.bot .b{background:#17232f;border:1px solid #213344;border-bottom-left-radius:4px}
.user .b{background:#2b5d86;border-bottom-right-radius:4px}
.kb{direction:rtl;display:flex;flex-direction:column;gap:4px;margin-top:4px}
.kr{display:flex;gap:4px}
.btn{flex:1;background:#1e3447;border:1px solid #2a465e;color:#bfe6f3;border-radius:9px;padding:9px 6px;text-align:center;font-size:13.5px;line-height:1.5;unicode-bidi:plaintext}
.btn.hl{background:#2f8aa1;border-color:#6cc4d9;color:#fff;font-weight:700}
.btn.hd{background:transparent;border-style:dashed;color:#7d92a3}
"""


def chat_html(items, title="DormLedger"):
    out = []
    for it in items:
        cls = "user" if it["from"] == "user" else "bot"
        kb = ""
        if it.get("keyboard"):
            rows = []
            for row in it["keyboard"]:
                btns = []
                for b in row:
                    extra = " hl" if b.get("hl") else (" hd" if b.get("callback_data") == "noop" else "")
                    btns.append(f'<div class="btn{extra}">{html.escape(b["text"])}</div>')
                rows.append('<div class="kr">' + "".join(btns) + "</div>")
            kb = '<div class="kb">' + "".join(rows) + "</div>"
        out.append(f'<div class="row {cls}"><div class="b">{html.escape(it["text"])}</div>{kb}</div>')
    return (f'<!doctype html><meta charset="utf-8"><style>{CHAT_CSS}</style>'
            f'<div class="top"><div class="av">DL</div><div><div class="nm">{title}</div><div class="sub">bot</div></div></div>'
            f'<div class="chat">{"".join(out)}</div>')


def chat_shots(browser):
    jobs = [("bot-01-settle.png", "settle_debtor"), ("bot-02-confirm.png", "settle_creditor"),
            ("bot-03-add-expense.png", "add_expense"), ("bot-04-guests.png", "guests")]
    for name, key in jobs:
        page = browser.new_page(viewport={"width": 390, "height": 200}, device_scale_factor=2)
        page.set_content(chat_html(CHATS[key]))
        page.wait_for_timeout(200)
        page.screenshot(path=str(IMG / name), full_page=True)
        page.close()
        print("wrote", name)


# ------------------------------------------------------------------ banner
BANNER = """<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1280px;height:640px;overflow:hidden;font-family:'DejaVu Sans',system-ui,sans-serif;color:#e8eef3;position:relative;
 background:radial-gradient(900px 520px at 8% -10%,#1b4a5c 0%,transparent 60%),radial-gradient(700px 500px at 100% 110%,#173a4a 0%,transparent 55%),#0a1217}
.l{position:absolute;left:64px;top:92px;width:610px}
.pill{display:inline-block;border:1px solid #243b49;background:#0f1d26;border-radius:999px;padding:7px 16px;font-size:15px;color:#b8cdd9}
h1{font-size:78px;line-height:1.05;margin:24px 0 16px;letter-spacing:-2px;font-weight:800;white-space:nowrap}h1 b{color:#6cc4d9}
.en{font-size:26px;line-height:1.4;color:#b8cdd9}
.fa{font-size:23px;line-height:1.7;color:#8fb0c2;margin-top:16px;direction:rtl;text-align:left}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
.chips span{border:1px solid #243b49;background:#0f1d26;border-radius:10px;padding:8px 14px;font-size:15px;color:#b8cdd9}
.ph{position:absolute;border-radius:36px;border:7px solid #1b2a34;background:#0a1217;overflow:hidden;box-shadow:0 30px 70px rgba(0,0,0,.55)}
.ph img{display:block;width:100%;height:auto}
.p1{left:742px;top:84px;width:236px;transform:rotate(-3deg)}
.p2{left:1000px;top:150px;width:236px;transform:rotate(3deg)}
.v2{position:absolute;right:30px;top:20px;background:#6cc4d9;color:#062029;font-weight:800;font-size:20px;border-radius:12px;padding:5px 14px;z-index:5}
</style>
<div class="v2">v2</div>
<div class="l"><span class="pill">&#9679; Telegram Mini App &amp; Bot &middot; Cloudflare Workers</span>
<h1>Dorm<b>Ledger</b></h1>
<p class="en">Split dorm expenses fairly, track who owes whom, and settle up &mdash; right inside Telegram.</p>
<p class="fa">تقسیم هزینه‌ی خوابگاه، تراز و تسویه‌ی حساب، مستقیم داخل تلگرام</p>
<div class="chips"><span>Guest members</span><span>Settle inside the chat</span><span>Exact splits</span><span>One-line install</span></div></div>
<div class="ph p1"><img src="data:image/png;base64,@@A@@"></div>
<div class="ph p2"><img src="data:image/png;base64,@@B@@"></div>
"""


def banner(browser):
    import base64
    b64 = lambda n: base64.b64encode((IMG / n).read_bytes()).decode()
    page = browser.new_page(viewport={"width": 1280, "height": 640})
    page.set_content(BANNER.replace("@@A@@", b64("06-add-expense.png")).replace("@@B@@", b64("bot-01-settle.png")))
    page.wait_for_timeout(400)
    page.screenshot(path=str(ROOT / "docs" / "social-preview.png"))
    page.close()
    print("wrote social-preview.png")


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        if only in ("all", "app"): app_shots(browser)
        if only in ("all", "chat"): chat_shots(browser)
        if only in ("all", "banner"): banner(browser)
        browser.close()


if __name__ == "__main__":
    main()
