#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
release_to_github.py - publish a new DormLedger version to your GitHub repository, almost hands-free.

Put this file NEXT TO the project folder (or run it from inside the project, as scripts/release_to_github.py):

    python release_to_github.py                    # project folder = ./dormledger, or the folder that holds this script
    python release_to_github.py --project D:\\bot\\dormledger
    python release_to_github.py --dry-run          # do everything except pushing

What it does, and stops at the first problem (it never force-pushes):
  1. checks the project (and refuses to publish secrets / wrangler.jsonc / database dumps)
  2. signs you in to GitHub through the browser:
       - GitHub CLI (`gh`) if installed: `gh auth login --web`
       - otherwise Git Credential Manager (ships with Git for Windows): the same browser sign-in
       - otherwise it opens the "new token" page and asks you to paste one (hidden, never saved)
  3. clones your existing repository, replaces its files with the project, and shows what changed
  4. commits, tags the version (from package.json), pushes, and creates a GitHub Release with the
     notes from CHANGELOG.md; fills the repository description and topics if they are empty
  5. checks that the one-line PowerShell installer is reachable

Options:  --repo owner/name   --branch main   --yes   --no-release   --no-meta   --keep-work
          --remote URL        push to this git URL instead (testing / other hosts)
Environment: GITHUB_TOKEN / GH_TOKEN skips the sign-in; GITHUB_API_URL points to another API (testing).
"""
from __future__ import annotations

import argparse
import base64
import fnmatch
import getpass
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

try:  # Persian text in the Windows console
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DEFAULT_REPO = "alireza-yahyae/dormledger"
API = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
RAW = os.environ.get("DORMLEDGER_RAW_URL", "https://raw.githubusercontent.com").rstrip("/")
TOPICS = ["telegram-bot", "telegram-mini-app", "cloudflare-workers", "cloudflare-d1", "expense-splitter", "persian", "rtl", "typescript", "powershell"]
DESCRIPTION = "Telegram bot + Mini App for splitting dorm expenses. Cloudflare Workers + D1, one-line PowerShell install."

# never copied into the repository, whatever they are
SKIP_DIRS = {".git", "node_modules", ".wrangler", "__pycache__", ".venv", "venv", "dist", ".idea", ".vscode"}
SKIP_NAMES = {"wrangler.jsonc", ".dev.vars", ".env", ".ds_store", "thumbs.db"}
SKIP_GLOBS = ("before-update*.sql", "backup*.sql", "*.backup.sql", "*.bak", "*.log", ".env.*")
TELEGRAM_TOKEN = re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")
GITHUB_TOKEN = re.compile(r"\b(ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b")


# ----------------------------------------------------------------------------- small helpers
def say(text: str = "") -> None:
    print(text, flush=True)


def title(text: str) -> None:
    say()
    say("=" * 66)
    say(text)
    say("=" * 66)


class Stop(Exception):
    """A problem the user can fix; the message says how."""


def ask_yes(question: str, assume_yes: bool, default: bool = True) -> bool:
    if assume_yes:
        say(f"{question} -> بله (--yes)")
        return True
    try:
        answer = input(f"{question} [{'Y/n' if default else 'y/N'}]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        say()
        return False
    return default if not answer else answer in {"y", "yes", "ب", "بله"}


def rmtree(path: Path) -> None:
    """Delete a folder also on Windows, where git marks its object files read-only."""
    def fix(func, p, *_):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=fix)
    else:
        shutil.rmtree(path, onerror=fix)


def find_git() -> str | None:
    found = shutil.which("git")
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA", "")
    if local:  # the copy bundled with GitHub Desktop
        hits = sorted(Path(local, "GitHubDesktop").glob("app-*/resources/app/git/cmd/git.exe"))
        if hits:
            return str(hits[-1])
    return None


class Git:
    def __init__(self, exe: str, cwd: Path, auth_header: str | None = None):
        self.exe, self.cwd, self.auth_header = exe, cwd, auth_header

    def run(self, *args: str, check: bool = True, network: bool = False, quiet: bool = True) -> subprocess.CompletedProcess:
        cmd = [self.exe]
        if network and self.auth_header:
            cmd += ["-c", f"http.extraheader={self.auth_header}"]
        cmd += list(args)
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never" if self.auth_header else os.environ.get("GCM_INTERACTIVE", "auto")}
        proc = subprocess.run(cmd, cwd=str(self.cwd), capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
        if check and proc.returncode != 0:
            raise Stop(f"دستور git ناموفق بود: git {' '.join(args)}\n{proc.stdout}{proc.stderr}".strip())
        if not quiet and proc.stdout.strip():
            say(proc.stdout.strip())
        return proc

    def out(self, *args: str) -> str:
        return self.run(*args, check=False).stdout.strip()


# ----------------------------------------------------------------------------- GitHub API
class Api:
    def __init__(self, token: str | None):
        self.token = token

    def call(self, method: str, path: str, body: dict | list | None = None) -> tuple[int, object]:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "dormledger-release", "X-GitHub-Api-Version": "2022-11-28"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                raw = resp.read().decode("utf-8", "replace")
                return resp.status, (json.loads(raw) if raw.strip() else {})
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                return exc.code, json.loads(raw)
            except ValueError:
                return exc.code, {"message": raw[:300]}
        except (urllib.error.URLError, OSError) as exc:
            raise Stop(f"به GitHub وصل نشد ({exc}). اینترنت/VPN را بررسی کنید و دوباره اجرا کنید.")


def basic_header(token: str) -> str:
    return "Authorization: Basic " + base64.b64encode(f"x-access-token:{token}".encode()).decode()


def token_from_gh(login: bool) -> str | None:
    """The GitHub CLI token. With login=True and no saved login, starts `gh auth login --web` (browser)."""
    gh = shutil.which("gh")
    if not gh:
        return None
    signed_in = subprocess.run([gh, "auth", "status", "--hostname", "github.com"], capture_output=True, text=True).returncode == 0
    if not signed_in:
        if not login:
            return None
        say("GitHub CLI پیدا شد ولی وارد نشده‌اید. مرورگر باز می‌شود؛ کدی که اینجا نشان داده می‌شود را در صفحه‌ی GitHub وارد و «Authorize» را بزنید.")
        code = subprocess.run([gh, "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "repo,workflow"]).returncode
        if code != 0:
            say("ورود با GitHub CLI کامل نشد؛ راه بعدی امتحان می‌شود.")
            return None
    tok = subprocess.run([gh, "auth", "token", "--hostname", "github.com"], capture_output=True, text=True).stdout.strip()
    return tok or None


def token_from_credential_helper(git: Git, reject_first: str | None = None) -> str | None:
    """Git Credential Manager (Git for Windows) opens the GitHub sign-in page in the browser when it has no saved login."""
    if reject_first:
        subprocess.run([git.exe, "credential", "reject"], input=f"protocol=https\nhost=github.com\npassword={reject_first}\n\n", capture_output=True, text=True)
    try:
        proc = subprocess.run([git.exe, "credential", "fill"], input="protocol=https\nhost=github.com\n\n", capture_output=True, text=True,
                              timeout=600, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    except (subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    fields = dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)
    return fields.get("password") or None


def token_by_hand() -> str:
    url = "https://github.com/settings/tokens/new?scopes=repo,workflow&description=DormLedger%20release"
    say("ورود خودکار ممکن نبود. در صفحه‌ای که باز می‌شود پایین صفحه «Generate token» را بزنید، توکن را کپی کنید و اینجا بچسبانید.")
    say("(توکن فقط در همین اجرا استفاده می‌شود و ذخیره نمی‌شود. در چت و جای دیگر هم نفرستیدش.)")
    say("  " + url)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        token = getpass.getpass("توکن (هنگام تایپ دیده نمی‌شود): ").strip()
    except (EOFError, OSError):
        token = ""
    if not token:
        raise Stop("توکنی وارد نشد.")
    return token


def sign_in(git: Git, repo_owner: str) -> tuple[Api, str]:
    """Returns (api with a valid token, how we signed in)."""
    env_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if env_token:
        if Api(env_token).call("GET", "/user")[0] != 200:
            raise Stop("توکن موجود در GITHUB_TOKEN / GH_TOKEN معتبر نیست (یا منقضی شده). آن را پاک کنید تا ورود با مرورگر انجام شود.")
        return Api(env_token), "متغیر محیطی"
    # 1) a login that already exists (gh), 2) the credential helper (Git Credential Manager: saved login, or its browser page),
    # 3) `gh auth login --web`, 4) a token pasted by hand
    for name, getter in (("GitHub CLI", lambda: token_from_gh(False)), ("Git Credential Manager", lambda: token_from_credential_helper(git)),
                         ("GitHub CLI (ورود تازه)", lambda: token_from_gh(True))):
        token = getter()
        if not token:
            continue
        if Api(token).call("GET", "/user")[0] == 200:
            return Api(token), name
        if name == "Git Credential Manager":  # a stale saved login: forget it and sign in again
            token = token_from_credential_helper(git, reject_first=token)
            if token and Api(token).call("GET", "/user")[0] == 200:
                return Api(token), name
    token = token_by_hand()
    if Api(token).call("GET", "/user")[0] != 200:
        raise Stop("GitHub این توکن را قبول نکرد. دوباره اجرا کنید و توکن را کامل کپی کنید.")
    return Api(token), "توکن دستی"


# ----------------------------------------------------------------------------- project files
def skipped(rel: Path) -> bool:
    if any(part in SKIP_DIRS for part in rel.parts[:-1]):
        return True
    name = rel.name.lower()
    if name in SKIP_NAMES or any(fnmatch.fnmatch(name, pat) for pat in SKIP_GLOBS):
        return True
    if name.endswith(".sql") and rel.parts[0] != "migrations":  # database exports hold real user data
        return True
    return name.endswith(".zip") and len(rel.parts) == 1


def project_files(project: Path) -> list[Path]:
    out = []
    for root, dirs, files in os.walk(project):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            rel = (Path(root) / f).relative_to(project)
            if not skipped(rel):
                out.append(rel)
    return sorted(out)


def check_project(project: Path) -> dict:
    missing = [n for n in ("package.json", "README.md", "src", "migrations", "ui", "scripts/install.ps1") if not (project / n).exists()]
    if missing:
        raise Stop(f"این پوشه شبیه پروژه‌ی DormLedger نیست (چیزهایی که نیست: {', '.join(missing)}).\nمسیر درست را با --project بدهید.")
    pkg = json.loads((project / "package.json").read_text(encoding="utf-8"))
    if pkg.get("name") != "dormledger":
        raise Stop("package.json مربوط به پروژه‌ی dormledger نیست.")
    return pkg


def scan_for_secrets(project: Path, files: list[Path]) -> None:
    leaks = []
    for rel in files:
        if rel.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".ico"}:
            continue
        try:
            text = (project / rel).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if TELEGRAM_TOKEN.search(text) or GITHUB_TOKEN.search(text):
            leaks.append(str(rel))
    if leaks:
        raise Stop("در این فایل‌ها چیزی شبیه توکن (راز) پیدا شد؛ چیزی آپلود نشد:\n  - " + "\n  - ".join(leaks) + "\nآن را پاک کنید و دوباره اجرا کنید.")


def release_notes(project: Path, version: str) -> str:
    changelog = project / "CHANGELOG.md"
    if changelog.is_file():
        text = changelog.read_text(encoding="utf-8")
        m = re.search(r"^## \[" + re.escape(version) + r"\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return f"DormLedger {version}"


# ----------------------------------------------------------------------------- main
def run(args: argparse.Namespace) -> int:
    script_dir = Path(__file__).resolve().parent
    if args.project:
        project = Path(args.project).expanduser().resolve()
    else:
        candidates = (script_dir / "dormledger", Path.cwd() / "dormledger", script_dir.parent, script_dir, Path.cwd())
        project = next((p for p in candidates if (p / "package.json").is_file() and (p / "scripts" / "install.ps1").is_file()), script_dir / "dormledger")
    title("۱) بررسی پروژه")
    pkg = check_project(project)
    version = str(pkg.get("version", "0.0.0"))
    tag = args.tag or f"v{version}"
    files = project_files(project)
    scan_for_secrets(project, files)
    say(f"[OK] پروژه: {project}")
    say(f"[OK] نسخه: {version} (برچسب {tag})، {len(files)} فایل؛ فایل‌های خصوصی (wrangler.jsonc، دیتابیس، توکن) کپی نمی‌شوند.")

    git_exe = find_git()
    if not git_exe:
        raise Stop("Git پیدا نشد. از https://git-scm.com نصب کنید (یا در PowerShell: winget install Git.Git) و دوباره اجرا کنید.")
    say(f"[OK] Git: {git_exe}")

    owner, name = args.repo.split("/", 1)
    github_remote = not args.remote
    remote_url = args.remote or f"https://github.com/{args.repo}.git"
    probe = Git(git_exe, project)

    title("۲) ورود به GitHub")
    api = Api(None)
    how = "بدون ورود (مقصد غیر GitHub)"
    login = owner
    user_info: dict = {}
    if github_remote or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"):
        api, how = sign_in(probe, owner)
        status, user_info = api.call("GET", "/user")
        login = str(user_info.get("login", owner)) if isinstance(user_info, dict) else owner
        say(f"[OK] وارد شدید ({how}) با حساب «{login}»")

    repo_info: dict = {}
    if api.token:
        status, info = api.call("GET", f"/repos/{owner}/{name}")
        if status == 404:
            if login.lower() != owner.lower():
                raise Stop(f"مخزن {args.repo} وجود ندارد و شما با حساب «{login}» وارد شده‌اید (نه «{owner}»).\nدر مرورگر با حساب درست وارد شوید: `gh auth logout` را بزنید و دوباره اجرا کنید.")
            say(f"مخزن {args.repo} هنوز وجود ندارد؛ ساخته می‌شود...")
            status, info = api.call("POST", "/user/repos", {"name": name, "description": DESCRIPTION, "private": False, "auto_init": False})
            if status not in (200, 201):
                raise Stop(f"ساخت مخزن ناموفق بود: {info}")
        elif status != 200:
            raise Stop(f"خواندن مخزن ناموفق بود (HTTP {status}): {info}")
        repo_info = info if isinstance(info, dict) else {}
        perms = repo_info.get("permissions") or {}
        if perms and not perms.get("push"):
            raise Stop(f"حساب «{login}» اجازه‌ی نوشتن در {args.repo} را ندارد. با حسابی که صاحب مخزن است وارد شوید.")
        say(f"[OK] مخزن {args.repo} ({'عمومی' if not repo_info.get('private') else 'خصوصی'})")
        if repo_info.get("private"):
            say("[توجه] مخزن خصوصی است؛ فرمان نصب یک‌خطی PowerShell فقط وقتی کار می‌کند که مخزن عمومی (Public) باشد.")

    header = basic_header(api.token) if (api.token and github_remote) else None

    work_parent = Path(tempfile.mkdtemp(prefix="dormledger-release-"))
    work = work_parent / "repo"
    try:
        title("۳) گرفتن مخزن فعلی و جایگزینی فایل‌ها")
        git = Git(git_exe, work_parent, header)
        clone = git.run("clone", remote_url, str(work), check=False, network=True)
        if clone.returncode != 0:
            raise Stop(f"clone ناموفق بود:\n{clone.stdout}{clone.stderr}".strip())
        git = Git(git_exe, work, header)
        git.run("config", "core.autocrlf", "false")
        branch = args.branch or git.out("symbolic-ref", "--short", "HEAD") or "main"
        if git.run("rev-parse", "--verify", "HEAD", check=False).returncode != 0:
            git.run("checkout", "-B", branch)  # empty repository
        elif git.out("symbolic-ref", "--short", "HEAD") != branch:
            git.run("checkout", branch)
        if branch != "main":
            say(f"[توجه] شاخه‌ی اصلی «{branch}» است. فرمان نصب یک‌خطی README از شاخه‌ی main می‌خواند؛ بهتر است شاخه را به main تغییر نام بدهید.")

        for child in list(work.iterdir()):
            if child.name == ".git":
                continue
            rmtree(child) if child.is_dir() else child.unlink()
        for rel in files:
            dest = work / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(project / rel, dest)
        git.run("add", "-A")
        changes = [line for line in git.out("diff", "--cached", "--name-status").splitlines() if line.strip()]
        counts = {"A": 0, "M": 0, "D": 0, "R": 0}
        for line in changes:
            counts[line[0]] = counts.get(line[0], 0) + 1
        say(f"تغییرات نسبت به مخزن فعلی: {counts['A']} فایل جدید، {counts['M']} فایل تغییر کرده، {counts['D']} فایل حذف‌شده.")
        for line in changes[:40]:
            say("   " + line.replace("\t", "  "))
        if len(changes) > 40:
            say(f"   ... و {len(changes) - 40} مورد دیگر")

        tracked = git.out("ls-files").splitlines()
        bad = [f for f in tracked if skipped(Path(f))]
        if bad:
            raise Stop("این فایل‌های خصوصی در commit بودند؛ متوقف شد:\n  - " + "\n  - ".join(bad))

        remote_has_tag = bool(git.run("ls-remote", "--tags", "origin", f"refs/tags/{tag}", check=False, network=True).stdout.strip())
        if not changes and remote_has_tag:
            say(f"\nچیزی برای انتشار نیست: مخزن همین الان همین نسخه و برچسب {tag} را دارد.")
            return 0
        if remote_has_tag:
            raise Stop(f"برچسب {tag} از قبل در مخزن هست. در package.json نسخه را بالا ببرید (مثلاً {version}.1) یا با --tag نام دیگری بدهید.")

        title("۴) commit، برچسب نسخه و ارسال")
        if not git.out("config", "user.name"):
            git.run("config", "user.name", str(user_info.get("name") or login) if isinstance(user_info, dict) else login)
        if not git.out("config", "user.email"):
            uid = user_info.get("id") if isinstance(user_info, dict) else None
            git.run("config", "user.email", f"{uid}+{login}@users.noreply.github.com" if uid else f"{login}@users.noreply.github.com")
        notes = release_notes(project, version)
        if changes:
            summary = "\n".join(notes.splitlines()[:14])
            git.run("commit", "-m", f"DormLedger {version}", "-m", summary)
            say(f"[OK] commit ساخته شد: {git.out('log', '--oneline', '-1')}")
        else:
            say("فایلی تغییر نکرده؛ فقط برچسب نسخه ساخته می‌شود.")
        git.run("tag", "-a", tag, "-m", f"DormLedger {version}")

        if args.dry_run:
            say(f"\n(--dry-run) تا اینجا همه‌چیز درست بود. چیزی ارسال نشد. پوشه‌ی کار: {work}")
            args.keep_work = True
            return 0
        if not ask_yes(f"ارسال به {args.repo} (شاخه‌ی {branch} و برچسب {tag})؟", args.yes):
            say("لغو شد؛ چیزی ارسال نشد.")
            return 0

        push = git.run("push", "origin", f"HEAD:refs/heads/{branch}", check=False, network=True)
        if push.returncode != 0:
            text = push.stdout + push.stderr
            if "workflow" in text and "scope" in text:
                raise Stop("GitHub اجازه نمی‌دهد با این ورود فایل‌های .github/workflows را عوض کنید (دسترسی «workflow» لازم است).\nدر PowerShell بزنید: gh auth refresh -h github.com -s workflow   و دوباره اجرا کنید.")
            if "non-fast-forward" in text or "rejected" in text:
                raise Stop("GitHub ارسال را رد کرد چون در این فاصله چیز تازه‌ای در مخزن آمده. دوباره اجرا کنید (همه‌چیز را از نو می‌گیرد).\n" + text.strip())
            raise Stop("ارسال ناموفق بود:\n" + text.strip())
        git.run("push", "origin", f"refs/tags/{tag}", network=True)
        say(f"[OK] ارسال شد: شاخه‌ی {branch} و برچسب {tag}")
        if how.startswith("Git Credential Manager") and api.token:  # remember a working login for next time
            subprocess.run([git_exe, "credential", "approve"], input=f"protocol=https\nhost=github.com\nusername={login}\npassword={api.token}\n\n", capture_output=True, text=True)

        if api.token:
            if not args.no_release:
                status, rel = api.call("POST", f"/repos/{owner}/{name}/releases", {"tag_name": tag, "name": f"DormLedger {version}", "body": notes, "draft": False, "prerelease": False, "make_latest": "true"})
                if status in (200, 201):
                    say(f"[OK] Release ساخته شد: {rel.get('html_url') if isinstance(rel, dict) else ''}")
                elif status == 422:
                    say("[توجه] Release با این برچسب از قبل هست؛ دست نخورد.")
                else:
                    say(f"[هشدار] Release ساخته نشد (HTTP {status}): {rel}. می‌توانید دستی در github.com/{args.repo}/releases/new بسازید.")
            if not args.no_meta:
                patch = {}
                if not repo_info.get("description"):
                    patch["description"] = DESCRIPTION
                if patch:
                    api.call("PATCH", f"/repos/{owner}/{name}", patch)
                current = [str(t) for t in (repo_info.get("topics") or [])]
                merged = current + [t for t in TOPICS if t not in current]
                if merged != current:
                    status, _ = api.call("PUT", f"/repos/{owner}/{name}/topics", {"names": merged[:20]})
                    say("[OK] توضیح و topics مخزن تکمیل شد." if status == 200 else "[هشدار] topics تنظیم نشد (مشکلی نیست).")

        title("۵) بررسی نهایی")
        installer = f"{RAW}/{args.repo}/{branch}/scripts/install.ps1"
        try:
            with urllib.request.urlopen(urllib.request.Request(installer, headers={"User-Agent": "dormledger-release"}), timeout=30) as resp:
                ok = resp.status == 200 and b"Install-DormLedger" in resp.read(200000)
        except (urllib.error.URLError, OSError):
            ok = False
        say("[OK] نصب‌کننده‌ی PowerShell از اینترنت در دسترس است." if ok else "[توجه] نصب‌کننده هنوز از اینترنت خوانده نشد (تا یک دقیقه طول می‌کشد، یا مخزن خصوصی است).")

        title("تمام شد")
        say(f"  مخزن:     https://github.com/{args.repo}")
        say(f"  نسخه:     https://github.com/{args.repo}/releases/tag/{tag}")
        say("  نصب برای همه (PowerShell):")
        say(f"    irm {installer} | iex")
        say()
        say("یک کار دستی و اختیاری: Settings > General > Social preview > Upload an image > docs/social-preview.png")
        say("(GitHub اجازه نمی‌دهد این تصویر با برنامه آپلود شود.)")
        return 0
    finally:
        if not args.keep_work:
            rmtree(work_parent)


def main() -> int:
    ap = argparse.ArgumentParser(description="انتشار نسخه‌ی جدید DormLedger روی GitHub")
    ap.add_argument("--project", help="پوشه‌ی پروژه (پیش‌فرض: ./dormledger کنار این فایل)")
    ap.add_argument("--repo", default=DEFAULT_REPO, help=f"owner/name (پیش‌فرض: {DEFAULT_REPO})")
    ap.add_argument("--branch", help="شاخه (پیش‌فرض: شاخه‌ی اصلی مخزن)")
    ap.add_argument("--tag", help="نام برچسب (پیش‌فرض: v + نسخه‌ی package.json)")
    ap.add_argument("--remote", help="به جای GitHub به این آدرس git ارسال کن (آزمایش)")
    ap.add_argument("--yes", action="store_true", help="بدون پرسیدن ارسال کن")
    ap.add_argument("--dry-run", action="store_true", help="همه‌چیز را جز ارسال انجام بده")
    ap.add_argument("--no-release", action="store_true", help="GitHub Release نساز")
    ap.add_argument("--no-meta", action="store_true", help="توضیح و topics مخزن را دست نزن")
    ap.add_argument("--keep-work", action="store_true", help="پوشه‌ی موقت را نگه دار")
    args = ap.parse_args()
    if "/" not in args.repo:
        say("--repo باید به شکل owner/name باشد.")
        return 2
    try:
        return run(args)
    except Stop as exc:
        say()
        say(f"[توقف] {exc}")
        say("چیزی خراب نشد؛ بعد از رفع مشکل می‌توانید دوباره و با خیال راحت اجرا کنید.")
        return 1
    except KeyboardInterrupt:
        say("\nلغو شد.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
