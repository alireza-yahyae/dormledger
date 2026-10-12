#!/usr/bin/env python3
"""
publish_to_github.py - publish the DormLedger project to GitHub in one go.

Run it from inside the project folder (the one that contains README.md), or pass the folder:

    python publish_to_github.py
    python publish_to_github.py "C:\\path\\to\\dormledger"

What it does:
  1. finds Git (also the copy bundled with GitHub Desktop)
  2. refuses to continue if secrets / private files would be uploaded
  3. fills your GitHub username into the README files
  4. git init -> commit -> create the GitHub repository -> push

How the repository gets created (first one that works):
  a) GitHub CLI  `gh`  if it is installed and logged in
  b) a token in the environment variable GITHUB_TOKEN (never typed into any chat!)
  c) otherwise your browser opens github.com/new with the name pre-filled;
     you only press "Create repository", come back and press Enter.
     The push then asks you to sign in through the browser (Git Credential Manager).

Useful options:
    --user NAME      GitHub username (asked if missing)
    --repo NAME      repository name (default: dormledger)
    --private        create a private repository (default: public)
    --remote URL     push to this existing remote instead of creating one
    --yes            do not ask for confirmation
"""
import argparse
import base64
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

FORBIDDEN = re.compile(
    r"(^|/)(wrangler\.jsonc|\.dev\.vars|\.env(\..*)?|node_modules/.*|\.wrangler/.*|.*backup.*\.sql|.*\.bak)$", re.I
)
TOKEN_RE = re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")  # Telegram bot token shape
GH_TOKEN_RE = re.compile(r"\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b")


def die(msg):
    print("\nERROR: " + msg)
    sys.exit(1)


def step(msg):
    print("\n== " + msg)


def find_git():
    g = shutil.which("git")
    if g:
        return g
    local = os.environ.get("LOCALAPPDATA", "")
    pats = [os.path.join(local, "GitHubDesktop", "app-*", "resources", "app", "git", "cmd", "git.exe")]
    for p in pats:
        hits = sorted(glob.glob(p))
        if hits:
            return hits[-1]
    return None


class Git:
    def __init__(self, exe, cwd):
        self.exe, self.cwd = exe, cwd

    def run(self, *args, check=True, extra=None, quiet=False):
        cmd = [self.exe] + (extra or []) + list(args)
        r = subprocess.run(cmd, cwd=self.cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if check and r.returncode != 0:
            die("git %s failed:\n%s%s" % (" ".join(args), r.stdout, r.stderr))
        if not quiet and r.stdout.strip():
            print(r.stdout.strip())
        return r

    def out(self, *args):
        return self.run(*args, check=False, quiet=True).stdout.strip()


def ask(prompt, default=None):
    s = input(prompt + (" [%s]" % default if default else "") + ": ").strip()
    return s or (default or "")


def check_project(folder):
    need = ["README.md", "package.json", ".gitignore", "src", "migrations"]
    missing = [n for n in need if not os.path.exists(os.path.join(folder, n))]
    if missing:
        die("This does not look like the DormLedger folder (missing: %s).\nRun the script inside the project folder or pass its path." % ", ".join(missing))


def safety_check(git, folder):
    step("Safety check (what would be uploaded)")
    files = [f for f in git.out("ls-files").splitlines() if f]
    bad = [f for f in files if FORBIDDEN.search(f) or (f.lower().endswith(".sql") and not f.startswith("migrations/"))]
    leaks = []
    for f in files:
        p = os.path.join(folder, f)
        try:
            if os.path.getsize(p) > 2_000_000 or f.lower().endswith((".png", ".jpg", ".zip")):
                continue
            txt = open(p, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        if TOKEN_RE.search(txt) or GH_TOKEN_RE.search(txt):
            leaks.append(f)
    if bad or leaks:
        git.run("reset", check=False, quiet=True)
        msg = []
        if bad:
            msg.append("These private files would be uploaded:\n  - " + "\n  - ".join(bad))
        if leaks:
            msg.append("These files contain something that looks like a secret token:\n  - " + "\n  - ".join(leaks))
        die("\n".join(msg) + "\nRemove them (or add them to .gitignore) and run the script again. Nothing was uploaded.")
    print("%d files will be uploaded. No private files or tokens found." % len(files))


def fill_readme(folder, user, repo):
    changed = []
    for name, ph in (("README.md", "<you>"), ("README.fa.md", "<نام-کاربری-تو>")):
        p = os.path.join(folder, name)
        if os.path.exists(p):
            s = open(p, encoding="utf-8").read()
            if ph in s:
                s = s.replace(ph, user)
                if repo != "dormledger":
                    s = s.replace("/dormledger.git", "/%s.git" % repo)
                open(p, "w", encoding="utf-8", newline="\n").write(s)
                changed.append(name)
    return changed


def create_with_token(token, repo, private):
    req = urllib.request.Request(
        "https://api.github.com/user/repos",
        data=json.dumps({"name": repo, "private": private, "description": "Telegram Mini App + bot for splitting dorm expenses (Cloudflare Workers + D1)"}).encode(),
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "dormledger-publisher"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)["clone_url"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if e.code == 422 and "already exists" in body:
            die("A repository with this name already exists on your account. Use --repo OTHERNAME or delete it on github.com first.")
        die("GitHub refused to create the repository (HTTP %d): %s" % (e.code, body[:300]))


def main():
    ap = argparse.ArgumentParser(description="Publish DormLedger to GitHub")
    ap.add_argument("folder", nargs="?", default=os.getcwd())
    ap.add_argument("--user")
    ap.add_argument("--repo", default="dormledger")
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--remote")
    ap.add_argument("--name", help="git commit author name (if not configured)")
    ap.add_argument("--email", help="git commit author email (if not configured)")
    ap.add_argument("--yes", action="store_true")
    a = ap.parse_args()

    folder = os.path.abspath(a.folder)
    check_project(folder)
    exe = find_git()
    if not exe:
        die("Git was not found. Install it from https://git-scm.com or install GitHub Desktop, then run this again.")
    git = Git(exe, folder)
    print("Using Git: " + exe)

    user = a.user or ask("Your GitHub username")
    if not user and not a.remote:
        die("A GitHub username is required.")
    visibility = "PRIVATE" if a.private else "PUBLIC"
    print("\nProject folder : " + folder)
    print("Repository     : %s/%s (%s)" % (user or "-", a.repo, visibility))
    if not a.yes and ask("Continue? (y/n)", "y").lower() not in ("y", "yes"):
        die("Cancelled.")

    step("Preparing the repository")
    if not os.path.isdir(os.path.join(folder, ".git")):
        git.run("init", quiet=True)
    git.run("symbolic-ref", "HEAD", "refs/heads/main", quiet=True)
    if not git.out("config", "user.name"):
        git.run("config", "user.name", a.name or ask("Name for your commits (e.g. your name)"), quiet=True)
    if not git.out("config", "user.email"):
        git.run("config", "user.email", a.email or ask("Email for your commits (your GitHub email)"), quiet=True)
    if user:
        done = fill_readme(folder, user, a.repo)
        if done:
            print("Filled in your username in: " + ", ".join(done))

    git.run("add", "-A", quiet=True)
    safety_check(git, folder)

    step("Creating the commit")
    if git.out("status", "--porcelain"):
        git.run("commit", "-m", "Initial commit", quiet=True)
        print("Committed.")
    else:
        print("Nothing new to commit.")

    step("Creating the GitHub repository and uploading")
    extra, remote = None, a.remote
    has_remote = "origin" in git.out("remote").split()
    gh = shutil.which("gh")
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")

    if has_remote and not remote:
        print("A remote named 'origin' already exists - pushing to it.")
    elif remote:
        git.run("remote", "add", "origin", remote, quiet=True)
    elif gh and subprocess.run([gh, "auth", "status"], capture_output=True).returncode == 0:
        flag = "--private" if a.private else "--public"
        r = subprocess.run([gh, "repo", "create", "%s/%s" % (user, a.repo), flag, "--source", ".", "--remote", "origin", "--push"], cwd=folder)
        if r.returncode != 0:
            die("`gh repo create` failed (see message above).")
        return finish(user, a.repo)
    elif token:
        remote = create_with_token(token, a.repo, a.private)
        git.run("remote", "add", "origin", remote, quiet=True)
        basic = base64.b64encode(("x-access-token:" + token).encode()).decode()
        extra = ["-c", "http.extraheader=Authorization: Basic " + basic]
    else:
        url = "https://github.com/new?name=%s&visibility=%s" % (a.repo, "private" if a.private else "public")
        print("Opening your browser. On the page: do NOT add README/.gitignore/license, just click 'Create repository'.")
        print("If the browser did not open, go to: " + url)
        try:
            webbrowser.open(url)
        except Exception:
            pass
        input("\nAfter the repository is created, press Enter here to continue...")
        git.run("remote", "add", "origin", "https://github.com/%s/%s.git" % (user, a.repo), quiet=True)

    print("Uploading (a browser sign-in window may appear the first time)...")
    r = git.run("push", "-u", "origin", "main", check=False, extra=extra)
    if r.returncode != 0:
        die("Upload failed:\n%s\nCommon causes: the repository was not created yet, wrong username, or sign-in was cancelled.\nFix it and run the script again - it is safe to re-run." % (r.stderr or r.stdout))
    finish(user, a.repo)


def finish(user, repo):
    print("\nDone! Your project is on GitHub:")
    print("  https://github.com/%s/%s" % (user, repo))
    print("\nA few optional finishing touches on github.com:")
    print("  1. Settings > General > Social preview > upload docs/social-preview.png")
    print("  2. About (gear icon) > add a description and topics: telegram-bot, telegram-mini-app, cloudflare-workers, d1, persian")
    print("  3. Open the Actions tab - the tests run automatically and should turn green")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
