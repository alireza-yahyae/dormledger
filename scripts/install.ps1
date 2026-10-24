<#
  DormLedger - installer and updater for PowerShell (Windows PowerShell 5.1 or PowerShell 7+)

  Install, or update an existing install, with one line:

      irm https://raw.githubusercontent.com/alireza-yahyae/dormledger/main/scripts/install.ps1 | iex

  What it does (you only answer a few questions and sign in through the browser):
    1. checks / installs Git and Node.js (through winget, after asking)
    2. downloads the project (git clone, or a zip when Git is not available)
    3. npm install
    4. signs you in to Cloudflare (your browser opens once)
    5. asks for your Telegram bot token (from @BotFather) and checks that it works
    6. creates the D1 database, writes wrangler.jsonc, applies the migrations
    7. deploys the Worker, stores the secrets, connects the Telegram webhook, menu and commands

  Running it again later is the update: it takes a backup of the database, pulls the new code,
  applies new migrations, deploys and refreshes the bot menu. Your data and secrets stay.

  Options, set BEFORE the line above:    $env:DORMLEDGER_DIR = 'D:\bots\dormledger'
      DORMLEDGER_DIR            install folder              (default: ~\dormledger)
      DORMLEDGER_NAME           Worker / database name      (default: dormledger)
      DORMLEDGER_BOT_TOKEN      bot token, skips the question
      DORMLEDGER_BACKUP_CHAT_ID numeric Telegram id that gets the daily backup file (optional)
      DORMLEDGER_YES=1          do not ask yes/no questions
      DORMLEDGER_REPO           GitHub "owner/name"         (default: alireza-yahyae/dormledger)
      DORMLEDGER_BRANCH         branch to install           (default: main)
      DORMLEDGER_REPO_URL       full git URL instead of GitHub (for forks / tests)

  Or save the file, read it, and run it:   .\install.ps1 -Yes -Dir D:\bots\dormledger

  This file is plain ASCII on purpose, so it works in every console.
  It never calls "exit" (that would close your PowerShell window); on a problem it stops and says what to do.
#>

function Install-DormLedger {
    [CmdletBinding()]
    param(
        [string]$Dir = $env:DORMLEDGER_DIR,
        [string]$Name = $env:DORMLEDGER_NAME,
        [string]$BotToken = $env:DORMLEDGER_BOT_TOKEN,
        [string]$BackupChatId = $env:DORMLEDGER_BACKUP_CHAT_ID,
        [string]$Repo = $(if ($env:DORMLEDGER_REPO) { $env:DORMLEDGER_REPO } else { 'alireza-yahyae/dormledger' }),
        [string]$Branch = $(if ($env:DORMLEDGER_BRANCH) { $env:DORMLEDGER_BRANCH } else { 'main' }),
        [switch]$Yes,
        [switch]$SkipBackup
    )

    $ErrorActionPreference = 'Continue'   # native programs write to stderr; we check exit codes ourselves
    $script:AssumeYes = ($Yes.IsPresent -or $env:DORMLEDGER_YES -eq '1')
    $script:TgApi = if ($env:DORMLEDGER_TG_API) { $env:DORMLEDGER_TG_API.TrimEnd('/') } else { 'https://api.telegram.org' }
    $script:Steps = 8
    $script:StepNo = 0
    $minNode = [version]'22.13.0'

    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

    try {
        Write-Host ''
        Write-Host '  DormLedger - installer' -ForegroundColor Cyan
        Write-Host '  Telegram bot + Mini App on your own free Cloudflare account' -ForegroundColor DarkGray

        # ------------------------------------------------------------------ 1. tools
        Write-Step 'Checking your tools'
        Update-PathFromRegistry
        $node = Get-NodeVersion
        if ($null -eq $node -or $node -lt $minNode) {
            $have = if ($null -eq $node) { 'not installed' } else { "found $node" }
            Write-Warn "Node.js $minNode or newer is needed ($have)."
            if ((Confirm-Action 'Install the current Node.js LTS with winget now?') -and (Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS')) {
                $node = Get-NodeVersion
            }
            if ($null -eq $node -or $node -lt $minNode) {
                throw "Node.js $minNode+ is required. Install the LTS version from https://nodejs.org , then close this window, open a new PowerShell and run the same line again."
            }
        }
        Write-Ok "Node.js $node"
        if (-not (Test-Cmd 'npm')) { throw 'npm was not found next to Node.js. Reinstall Node.js from https://nodejs.org and open a new PowerShell window.' }

        $git = Test-Cmd 'git'
        if (-not $git) {
            Write-Warn 'Git is not installed (it is optional: without it the project is downloaded as a zip).'
            if ((Confirm-Action 'Install Git with winget now?') -and (Install-WithWinget 'Git.Git' 'Git')) { $git = Test-Cmd 'git' }
        }
        if ($git) { Write-Ok 'Git' } else { Write-Info 'Continuing without Git (zip download).' }

        # ------------------------------------------------------------------ 2. project files
        Write-Step 'Getting the project'
        if (-not $Dir) { $Dir = Pj $HOME 'dormledger' }
        $Dir = [IO.Path]::GetFullPath($Dir)
        $isProject = (Test-Path (Pj $Dir 'package.json')) -and (Test-Path (Pj $Dir 'migrations'))
        $repoUrl = if ($env:DORMLEDGER_REPO_URL) { $env:DORMLEDGER_REPO_URL } else { "https://github.com/$Repo.git" }

        if ($isProject) {
            Write-Info "Existing install found: $Dir"
            if ((Test-Path (Pj $Dir '.git')) -and $git) {
                $code = Invoke-Live $git @('-C', $Dir, 'pull', '--ff-only')
                if ($code -ne 0) { throw "Could not update the code in $Dir (you probably changed files there).`nRun:  git -C `"$Dir`" stash   and try again, or choose another folder with `$env:DORMLEDGER_DIR." }
            }
            elseif (-not (Test-Path (Pj $Dir '.git'))) {
                Get-ProjectZip $Repo $Branch $Dir
            }
        }
        else {
            if ((Test-Path $Dir) -and (@(Get-ChildItem -Force $Dir -ErrorAction SilentlyContinue).Count -gt 0)) {
                throw "The folder $Dir already exists and is not a DormLedger project.`nChoose another folder:  `$env:DORMLEDGER_DIR = 'D:\bots\dormledger'  and run the line again."
            }
            if ($git) {
                $code = Invoke-Live $git @('clone', '--depth', '1', '--branch', $Branch, $repoUrl, $Dir)
                if ($code -ne 0) { throw "git clone failed (see the message above). Check your internet connection and that github.com/$Repo is public." }
            }
            else { Get-ProjectZip $Repo $Branch $Dir }
        }
        if (-not (Test-Path (Pj $Dir 'package.json'))) { throw "The project files are not in $Dir." }
        Write-Ok $Dir

        # ------------------------------------------------------------------ 3. npm packages
        Write-Step 'Installing packages (npm install)'
        $code = Invoke-Live (Test-Cmd 'npm') @('install', '--no-audit', '--no-fund') $Dir
        if ($code -ne 0) { throw 'npm install failed (see the message above).' }
        $script:Wrangler = Pj $Dir 'node_modules' 'wrangler' 'bin' 'wrangler.js'
        if (-not (Test-Path $script:Wrangler)) { throw 'Wrangler (the Cloudflare tool) was not installed by npm install.' }
        $script:NodeExe = (Test-Cmd 'node')
        $script:Dir = $Dir
        Write-Ok 'Packages ready'

        Write-Info 'Running the tests, just to be sure everything works on this computer...'
        $t = Invoke-Capture (Test-Cmd 'npm') @('test') $Dir
        if ($t.Code -eq 0) { Write-Ok 'All tests passed' }
        else {
            Write-Warn 'Some tests failed on this computer:'
            Write-Host (($t.Out -split "`n" | Select-Object -Last 15) -join "`n") -ForegroundColor DarkGray
            if (-not (Confirm-Action 'Continue anyway?' $false -Strict)) { throw 'Stopped because the tests failed.' }
        }

        # ------------------------------------------------------------------ 4. Cloudflare login
        Write-Step 'Signing in to Cloudflare'
        $who = Invoke-Wrangler @('whoami')
        if ($who.Code -ne 0 -or $who.Out -match 'not authenticated') {
            Write-Info 'Your browser opens now. Sign in to Cloudflare (create a free account if you have none) and press "Allow".'
            $code = Invoke-WranglerLive @('login')
            if ($code -ne 0) { throw 'Cloudflare sign-in did not finish. Run the line again and complete it in the browser.' }
            $who = Invoke-Wrangler @('whoami')
        }
        $accounts = @(Get-Accounts $who.Out)
        if ($accounts.Count -gt 1) {
            Write-Info 'Your Cloudflare login has several accounts:'
            for ($i = 0; $i -lt $accounts.Count; $i++) { Write-Host ("   {0}) {1}  ({2})" -f ($i + 1), $accounts[$i].Name, $accounts[$i].Id) }
            $pick = 0
            if ($script:AssumeYes) { $pick = 1; Write-Info 'Using the first one (-Yes).' }
            while ($pick -lt 1 -or $pick -gt $accounts.Count) {
                [void][int]::TryParse((Read-Line "Which one should host DormLedger? [1-$($accounts.Count)]"), [ref]$pick)
            }
            $env:CLOUDFLARE_ACCOUNT_ID = $accounts[$pick - 1].Id
        }
        elseif ($accounts.Count -eq 1) { $env:CLOUDFLARE_ACCOUNT_ID = $accounts[0].Id }
        Write-Ok 'Signed in to Cloudflare'

        # ------------------------------------------------------------------ 5. names, bot token
        $cfgPath = Pj $Dir 'wrangler.jsonc'
        $fresh = -not (Test-Path $cfgPath)
        if ($fresh) {
            if (-not $Name -and -not $script:AssumeYes) { $Name = Read-Line 'Name for your Worker and database (just press Enter for "dormledger")' }
            if (-not $Name) { $Name = 'dormledger' }
            $Name = $Name.Trim().ToLower()
            if ($Name -notmatch '^[a-z0-9][a-z0-9-]{0,40}$') { throw 'The name may only contain a-z, 0-9 and "-" (for example: dormledger).' }
        }
        else {
            $Name = Get-ConfigValue $cfgPath 'name'
            Write-Info "Existing configuration found: $cfgPath (worker `"$Name`")"
        }
        $dbName = if ($fresh) { $Name } else { (Get-ConfigValue $cfgPath 'database_name') }
        if (-not $dbName) { $dbName = $Name }

        # the bot token (needed when the worker has no BOT_TOKEN secret yet)
        $botUser = $null
        $needToken = $true
        if (-not $fresh) {
            $sl = Invoke-Wrangler @('secret', 'list', '--format', 'json')
            if ($sl.Code -eq 0 -and $sl.Out -match '"BOT_TOKEN"') { $needToken = $false }
        }
        if ($needToken) {
            Write-Step 'Telegram bot'
            Write-Info 'In Telegram open @BotFather, send /newbot, choose a name, and copy the token it gives you (looks like 123456789:AA...).'
            if (-not $BotToken -and -not $script:AssumeYes) { try { Start-Process 'https://t.me/BotFather' } catch { } }
            $tries = 0
            while ($true) {
                if (-not $BotToken) { $BotToken = (Read-Secret 'Paste the bot token here (it is hidden) and press Enter').Trim() }
                $res = Test-BotToken $BotToken
                if ($res.Ok) { $botUser = $res.Username; break }
                $tries++
                Write-Warn $res.Message
                $BotToken = $null
                if ($tries -ge 3) { throw 'No valid bot token. Get one from @BotFather and run the line again.' }
            }
            Write-Ok "Bot @$botUser"
        }

        if ($fresh -and -not $BackupChatId -and -not $script:AssumeYes) {
            Write-Info 'Optional: a daily backup file can be sent to your own Telegram chat. Your numeric id: ask @userinfobot. (Press Enter to skip; you can add it later.)'
            $BackupChatId = (Read-Line 'Your numeric Telegram id').Trim()
        }

        Write-Step 'Preparing the database'
        $db = Find-Database $dbName
        $dbExisted = $null -ne $db
        if ($fresh -and $dbExisted) {
            Write-Warn "A database called `"$dbName`" already exists in your Cloudflare account."
            Write-Info 'Reusing it keeps its data; only new tables/columns are added. (This is what you want when updating.)'
            if (-not (Confirm-Action 'Reuse it?')) { throw 'Run the line again and choose another name when asked (or set $env:DORMLEDGER_NAME).' }
        }
        if (-not $dbExisted) {
            Write-Info "Creating the D1 database `"$dbName`"..."
            [void](Invoke-Wrangler @('d1', 'create', $dbName))
            $db = Find-Database $dbName
            if ($null -eq $db) { throw "The database `"$dbName`" could not be created. Run `"node node_modules\wrangler\bin\wrangler.js d1 create $dbName`" inside $Dir to see the reason." }
        }
        Write-Ok "Database $dbName ($($db.uuid))"

        if ($fresh) {
            $tpl = Pj $Dir 'wrangler.example.jsonc'
            if (-not (Test-Path $tpl)) { throw 'wrangler.example.jsonc is missing from the project.' }
            $text = [IO.File]::ReadAllText($tpl)
            $text = $text.Replace('"name": "dormledger"', "`"name`": `"$Name`"").Replace('"database_name": "dormledger"', "`"database_name`": `"$dbName`"").Replace('REPLACE_WITH_YOUR_D1_DATABASE_ID', $db.uuid)
            Write-Text $cfgPath $text
        }
        elseif ((Get-ConfigValue $cfgPath 'database_id') -ne $db.uuid) {
            Set-ConfigValue $cfgPath 'database_id' $db.uuid
            Write-Info 'database_id in wrangler.jsonc was updated.'
        }

        if ($fresh -and $BackupChatId) {
            if ($BackupChatId -match '^-?\d{5,15}$') { Add-ConfigVar $cfgPath 'BACKUP_CHAT_ID' $BackupChatId }
            else { Write-Warn 'That does not look like a numeric id - backups were not configured (see the README, section Backups).' }
        }

        # backup of an already-used database, before touching it
        if ($dbExisted -and -not $SkipBackup) {
            $bdir = Pj $Dir 'backups'
            [void](New-Item -ItemType Directory -Force -Path $bdir)
            $bfile = Pj $bdir ("before-update-{0}.sql" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
            Write-Info 'Saving a copy of your database first (it stays on this computer; it holds real user data, never share it)...'
            $code = Invoke-WranglerLive @('d1', 'export', $dbName, '--remote', '--output', $bfile)
            if ($code -eq 0 -and (Test-Path $bfile)) { Write-Ok "Backup: $bfile" }
            else {
                Write-Warn 'The backup could not be made.'
                if (-not (Confirm-Action 'Continue without a backup?' $false -Strict)) { throw 'Stopped: no backup was made. Nothing was changed on the server.' }
            }
        }

        # ------------------------------------------------------------------ 6. database tables
        Write-Step 'Creating / updating the database tables'
        $oldCi = $env:CI
        $env:CI = 'true'   # makes wrangler skip its own "are you sure?" question
        $code = Invoke-WranglerLive @('d1', 'migrations', 'apply', $dbName, '--remote')
        $env:CI = $oldCi
        if ($code -ne 0) { throw 'Applying the database migrations failed (see the message above). Nothing was deployed.' }
        Write-Ok 'Database is up to date'

        # ------------------------------------------------------------------ 7. deploy
        Write-Step 'Publishing the app to Cloudflare'
        $outFile = Join-Path ([IO.Path]::GetTempPath()) ('dormledger-deploy-' + [guid]::NewGuid().ToString('N') + '.ndjson')
        $logFile = $outFile + '.log'
        $env:WRANGLER_OUTPUT_FILE_PATH = $outFile
        $env:WRANGLER_LOG_PATH = $logFile
        $url = $null
        try {
            [void](Invoke-Live $script:NodeExe @((Pj $Dir 'scripts' 'build-ui.mjs')) $Dir)
            Write-Info 'If Cloudflare asks you to choose a workers.dev subdomain, type any name you like (this is part of your app address).'
            $code = Invoke-WranglerLive @('deploy')
            if ($code -ne 0) { throw 'The deploy failed (see the message above).' }
            $url = Get-DeployedUrl $outFile $logFile $Name
        }
        finally {
            Remove-Item Env:\WRANGLER_OUTPUT_FILE_PATH -ErrorAction SilentlyContinue
            Remove-Item Env:\WRANGLER_LOG_PATH -ErrorAction SilentlyContinue
            Remove-Item $outFile, $logFile -Force -ErrorAction SilentlyContinue
        }
        if (-not $url) {
            Write-Warn 'The address of your app could not be read automatically.'
            $url = (Read-Line 'Copy the https://...workers.dev address printed above and paste it here').Trim()
        }
        $url = $url.TrimEnd('/')
        if ($url -notmatch '^https://[a-z0-9.-]+$') { throw "That is not a valid https address: $url" }
        Write-Ok "App address: $url"

        $current = Get-ConfigValue $cfgPath 'APP_URL'
        $redeploy = $false
        if ($current -ne $url) { Set-ConfigValue $cfgPath 'APP_URL' $url; $redeploy = $true; Write-Info 'APP_URL in wrangler.jsonc was set.' }

        # ------------------------------------------------------------------ 8. secrets, webhook
        Write-Step 'Storing secrets and connecting Telegram'
        $webhookSecret = New-RandomHex 32
        $secrets = [ordered]@{ WEBHOOK_SECRET = $webhookSecret }
        if ($needToken) { $secrets['BOT_TOKEN'] = $BotToken }
        Set-WorkerSecrets $secrets
        $BotToken = $null
        Write-Ok 'Secrets stored (they are never written to disk here)'

        if ($redeploy) {
            Write-Info 'Publishing once more so the app knows its own address...'
            $code = Invoke-WranglerLive @('deploy')
            if ($code -ne 0) { throw 'The second deploy failed (see the message above).' }
        }

        $setup = Invoke-SetupCall $url $webhookSecret
        $webhookSecret = $null
        if (-not $setup.Ok) {
            Write-Warn "Telegram was not connected automatically: $($setup.Message)"
            Write-Info 'This is usually a new address that is not reachable yet. Wait a minute and run the same line again - it only repeats the last steps.'
        }
        else { Write-Ok 'Telegram webhook, menu button and commands are set' }

        # ------------------------------------------------------------------ done
        Write-Host ''
        Write-Host '  ================================================================' -ForegroundColor Green
        Write-Host '   DONE - DormLedger is running' -ForegroundColor Green
        Write-Host '  ================================================================' -ForegroundColor Green
        if ($botUser) { Write-Host "   Your bot  : https://t.me/$botUser" }
        Write-Host "   Mini App  : $url"
        Write-Host "   Folder    : $Dir"
        Write-Host "   Settings  : $cfgPath   (private - do not share or upload it)"
        Write-Host ''
        Write-Host '   Next: open your bot in Telegram, press Start, create your room, share the invite code.'
        Write-Host '   Update later: run the same one-line command again (a backup is taken first).'
        Write-Host ''
        if ($botUser -and -not $script:AssumeYes) { try { Start-Process "https://t.me/$botUser" } catch { } }
    }
    catch {
        Write-Host ''
        Write-Host ("  [FAIL] " + $_.Exception.Message) -ForegroundColor Red
        Write-Host '         Fix the problem and run the same line again. It continues where it stopped; nothing is duplicated.' -ForegroundColor DarkGray
    }
}

# ====================================================================== helpers (all ASCII)

function Pj { [IO.Path]::Combine([string[]]$args) }

function Write-Step {
    param([string]$Text)
    $script:StepNo++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $script:StepNo, $Text) -ForegroundColor Cyan
}
function Write-Ok { param([string]$Text) Write-Host "  [ OK ] $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  [ !! ] $Text" -ForegroundColor Yellow }
function Write-Info { param([string]$Text) Write-Host "  [ >> ] $Text" -ForegroundColor Gray }

function Read-Line { param([string]$Prompt) $r = Read-Host -Prompt $Prompt; if ($null -eq $r) { '' } else { [string]$r } }

function Read-Secret {
    param([string]$Prompt)
    $s = Read-Host -Prompt $Prompt -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Confirm-Action {
    param([string]$Question, [bool]$Default = $true, [switch]$Strict)
    # -Yes answers "yes" to routine questions, but never to a risky one (-Strict): there the safe default is used
    if ($script:AssumeYes -and $Strict) { Write-Info "$Question -> $(if ($Default) { 'yes' } else { 'no' }) (safe default)"; return $Default }
    if ($script:AssumeYes) { Write-Info "$Question -> yes"; return $true }
    $suffix = if ($Default) { '[Y/n]' } else { '[y/N]' }
    $a = (Read-Line "$Question $suffix").Trim().ToLower()
    if ($a -eq '') { return $Default }
    return ($a -eq 'y' -or $a -eq 'yes')
}

function Test-Windows { return ($PSVersionTable.PSEdition -ne 'Core') -or ($IsWindows -eq $true) }

function Test-Cmd {
    param([string]$Name)
    $c = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { $c = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if ($c) { return $c.Source } else { return $null }
}

function Update-PathFromRegistry {
    if (-not (Test-Windows)) { return }
    try {
        $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $u = [Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
    } catch { }
}

function Get-NodeVersion {
    $n = Test-Cmd 'node'
    if (-not $n) { return $null }
    $v = (& $n --version 2>$null) | Select-Object -First 1
    if ($v -match '^v?(\d+)\.(\d+)\.(\d+)') { return [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3]) }
    return $null
}

function Install-WithWinget {
    param([string]$Id, [string]$Label)
    $w = Test-Cmd 'winget'
    if (-not $w) { Write-Warn 'winget is not available on this computer.'; return $false }
    Write-Info "Installing $Label (Windows may ask for permission)..."
    [void](Invoke-Live $w @('install', '--id', $Id, '-e', '--accept-package-agreements', '--accept-source-agreements'))
    Update-PathFromRegistry
    return $true
}

# Runs a program with the real console attached (live output, prompts and colours work). Returns the exit code.
function Invoke-Live {
    param([string]$Exe, [string[]]$ArgList, [string]$WorkDir = (Get-Location).Path)
    $quoted = ($ArgList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
    $p = Start-Process -FilePath $Exe -ArgumentList $quoted -WorkingDirectory $WorkDir -NoNewWindow -Wait -PassThru
    $null = $p.Handle
    return $p.ExitCode
}

# Runs a program and captures its output (no console needed). Returns Code / Out / Err.
function Invoke-Capture {
    param([string]$Exe, [string[]]$ArgList, [string]$WorkDir = (Get-Location).Path)
    $errFile = [IO.Path]::GetTempFileName()
    Push-Location $WorkDir
    try {
        $out = (& $Exe @ArgList 2>$errFile | Out-String)
        $code = $LASTEXITCODE
    }
    finally { Pop-Location }
    $err = ''
    try { $err = [IO.File]::ReadAllText($errFile) } catch { }
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Code = $code; Out = $out; Err = $err }
}

function Invoke-Wrangler { param([string[]]$WArgs) return (Invoke-Capture $script:NodeExe (@($script:Wrangler) + $WArgs) $script:Dir) }
function Invoke-WranglerLive { param([string[]]$WArgs) return (Invoke-Live $script:NodeExe (@($script:Wrangler) + $WArgs) $script:Dir) }

function Get-ProjectZip {
    param([string]$Repo, [string]$Branch, [string]$Dir)
    $zip = Join-Path ([IO.Path]::GetTempPath()) ('dormledger-' + [guid]::NewGuid().ToString('N') + '.zip')
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('dormledger-' + [guid]::NewGuid().ToString('N'))
    $url = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
    Write-Info "Downloading $url"
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $root = Get-ChildItem $tmp | Where-Object { $_.PSIsContainer } | Select-Object -First 1
        if (-not $root) { throw 'The downloaded zip is empty.' }
        [void](New-Item -ItemType Directory -Force -Path $Dir)
        foreach ($item in Get-ChildItem -Force $root.FullName) {
            if ($item.Name -in @('wrangler.jsonc', '.dev.vars', 'node_modules', 'backups')) { continue }
            Copy-Item -Path $item.FullName -Destination $Dir -Recurse -Force
        }
    }
    catch { throw "Downloading the project failed: $($_.Exception.Message)" }
    finally { Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---- config file (wrangler.jsonc): plain-text edits that keep the comments ----
function Write-Text {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-ConfigValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return $null }
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line.TrimStart().StartsWith('//')) { continue }
        $m = [regex]::Match($line, '"' + [regex]::Escape($Key) + '"\s*:\s*"([^"]*)"')
        if ($m.Success) { return $m.Groups[1].Value }
    }
    return $null
}

function Set-ConfigValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = [IO.File]::ReadAllLines($Path)
    $re = '("' + [regex]::Escape($Key) + '"\s*:\s*")[^"]*(")'
    $done = $false
    for ($i = 0; $i -lt $lines.Count -and -not $done; $i++) {
        if ($lines[$i].TrimStart().StartsWith('//')) { continue }
        if ([regex]::IsMatch($lines[$i], $re)) {
            $lines[$i] = [regex]::Replace($lines[$i], $re, { param($m) $m.Groups[1].Value + $Value + $m.Groups[2].Value })
            $done = $true
        }
    }
    if (-not $done) { throw "Could not find `"$Key`" in $Path" }
    Write-Text $Path (($lines -join "`n") + "`n")
}

# adds  "NAME": "value"  to the "vars" block (right after APP_URL)
function Add-ConfigVar {
    param([string]$Path, [string]$VarName, [string]$Value)
    if ($null -ne (Get-ConfigValue $Path $VarName)) { Set-ConfigValue $Path $VarName $Value; return }
    $lines = [IO.File]::ReadAllLines($Path)
    $out = New-Object System.Collections.Generic.List[string]
    $done = $false
    foreach ($l in $lines) {
        if (-not $done -and -not $l.TrimStart().StartsWith('//') -and $l -match '^(\s*)"APP_URL"\s*:\s*"[^"]*"\s*$') {
            $out.Add($l + ',')
            $out.Add($Matches[1] + '"' + $VarName + '": "' + $Value + '"')
            $done = $true
        }
        else { $out.Add($l) }
    }
    if (-not $done) { throw "Could not add $VarName to $Path (no APP_URL line found)." }
    Write-Text $Path (($out -join "`n") + "`n")
}

# ---- Cloudflare ----
function Get-Accounts {
    param([string]$Text)
    $list = @()
    $seen = @{}
    foreach ($line in ($Text -split "`n")) {
        $m = [regex]::Match($line, '([0-9a-f]{32})')
        if (-not $m.Success -or $seen.ContainsKey($m.Value)) { continue }
        $seen[$m.Value] = $true
        $nm = ($line -split '[|\u2502]' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^[0-9a-f]{32}$' } | Select-Object -First 1)
        $list += [pscustomobject]@{ Name = $nm; Id = $m.Value }
    }
    return $list
}

function Find-Database {
    param([string]$DbName)
    $r = Invoke-Wrangler @('d1', 'list', '--json')
    if ($r.Code -ne 0) { return $null }
    try { $all = $r.Out | ConvertFrom-Json } catch { return $null }
    foreach ($d in @($all)) { if ($d.name -eq $DbName) { return $d } }
    return $null
}

function Get-DeployedUrl {
    param([string]$OutFile, [string]$LogFile, [string]$WorkerName)
    if (Test-Path $OutFile) {
        foreach ($line in [IO.File]::ReadAllLines($OutFile)) {
            try { $o = $line | ConvertFrom-Json } catch { continue }
            if ($o.type -eq 'deploy') { foreach ($t in @($o.targets)) { if ("$t" -match '^https://[a-z0-9.-]+\.workers\.dev') { return $Matches[0] } } }
        }
    }
    if (Test-Path $LogFile) {
        $txt = [IO.File]::ReadAllText($LogFile)
        $m = [regex]::Matches($txt, 'https://' + [regex]::Escape($WorkerName) + '\.[a-z0-9-]+\.workers\.dev')
        if ($m.Count -gt 0) { return $m[$m.Count - 1].Value }
    }
    return $null
}

function New-RandomHex {
    param([int]$Bytes = 32)
    $b = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($b) } finally { $rng.Dispose() }
    return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

# secrets go through a temporary JSON file that is deleted right away (wrangler "secret bulk"); falls back to "secret put"
function Set-WorkerSecrets {
    param($Secrets)
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('dl-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        Write-Text $tmp ($Secrets | ConvertTo-Json -Compress)
        $r = Invoke-Wrangler @('secret', 'bulk', $tmp)
    }
    finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    if ($r.Code -eq 0) { return }
    Write-Info 'Falling back to storing the secrets one by one...'
    foreach ($k in $Secrets.Keys) {
        $val = $Secrets[$k]
        $p = Invoke-SecretPut $k $val
        if ($p -ne 0) { throw "Could not store the secret $k. Run the line again." }
    }
}

function Invoke-SecretPut {
    param([string]$SecretName, [string]$Value)
    Push-Location $script:Dir
    try {
        $null = ($Value | & $script:NodeExe $script:Wrangler secret put $SecretName 2>&1 | Out-String)
        return $LASTEXITCODE
    }
    finally { Pop-Location }
}

# ---- Telegram ----
function Test-BotToken {
    param([string]$Token)
    if ($Token -notmatch '^\d{6,12}:[A-Za-z0-9_-]{30,50}$') {
        return [pscustomobject]@{ Ok = $false; Username = $null; Message = 'That does not look like a bot token. It looks like 123456789:AAxxxxxxxx... - copy it again from @BotFather.' }
    }
    try {
        $r = Invoke-RestMethod -Uri "$($script:TgApi)/bot$Token/getMe" -Method Get -TimeoutSec 30
        if ($r.ok) { return [pscustomobject]@{ Ok = $true; Username = $r.result.username; Message = '' } }
    }
    catch { }
    return [pscustomobject]@{ Ok = $false; Username = $null; Message = 'Telegram does not accept this token (or it cannot be reached). Check that you copied all of it.' }
}

# opens <app>/setup?key=...  (registers the webhook, the menu button and the command list); a fresh address may need a minute
function Invoke-SetupCall {
    param([string]$Url, [string]$Key)
    $last = ''
    for ($i = 1; $i -le 12; $i++) {
        try {
            $r = Invoke-RestMethod -Uri ("$Url/setup?key=$Key") -Method Get -TimeoutSec 30
            if ($r.webhook.ok -eq $true) { return [pscustomobject]@{ Ok = $true; Message = '' } }
            $last = 'Telegram answered: ' + (($r | ConvertTo-Json -Compress -Depth 5))
            break
        }
        catch { $last = $_.Exception.Message }
        Start-Sleep -Seconds 5
    }
    return [pscustomobject]@{ Ok = $false; Message = $last }
}

# ====================================================================== run
if (-not $env:DORMLEDGER_NO_RUN) { Install-DormLedger @args }
