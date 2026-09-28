# Synapsez — add this computer.
#
# Run the line the app gave you. The token arrives in $env:AIR_TOKEN, never in
# this file: a script assembled by joining a parameter into its own text and
# then piped into `iex` will run whatever that parameter contains, so the
# parameter is kept out of the text entirely.
#
#   $env:AIR_TOKEN='...'; irm https://your-app/setup.ps1 | iex
#
# Nothing here needs administrator rights, and nothing here should be given any.

$ErrorActionPreference = 'Stop'

function Say($text) { Write-Host "  $text" }
function Fail($text) { Write-Host ""; Write-Host "  $text" -ForegroundColor Red; Write-Host ""; exit 1 }

<#
.SYNOPSIS
  Run an external program, and judge it by its exit code.

.DESCRIPTION
  This exists because of one failure, and it stopped the installer dead on its
  first real use.

  `git clone` writes "Cloning into '...'" to **stderr**. That is progress, not an
  error — but with `$ErrorActionPreference = 'Stop'`, PowerShell 5.1 turns every
  stderr line from a native program into a terminating NativeCommandError the
  moment it is merged into the pipeline with `2>&1`. So a clone that had just
  succeeded aborted the script, with a red wall of text about a line that had
  worked.

  `$?` is no better: for native programs it follows the same wrapping rather than
  the program's own result. **The exit code is the only honest signal**, so that
  is what is checked.

  Output is captured rather than discarded, and shown only if the command fails —
  otherwise a failure would print a bare "npm install failed" with the reason
  thrown away.
#>
function Run($what, $exe, [string[]]$argv) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $exe @argv 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host ""
      Write-Host "  $what failed (exit $LASTEXITCODE):" -ForegroundColor Red
      $output | Select-Object -Last 12 | ForEach-Object { Write-Host "    $_" }
      Write-Host ""
      exit 1
    }
  } finally {
    $ErrorActionPreference = $previous
  }
}

Write-Host ""
Write-Host "  Synapsez" -ForegroundColor Green
Write-Host ""

# Everything variable arrives in the environment, and this file is byte-for-byte
# the same for every deployment and every user. That is deliberate: the moment a
# server builds this text by joining something into it, whatever was joined in
# becomes code, because the caller pipes the result straight into `iex`.

$token = $env:AIR_TOKEN
if (-not $token) {
  Fail "No setup token. Copy the whole line from the app - it sets AIR_TOKEN before calling this."
}

$server = $env:AIR_SERVER
if (-not $server) {
  Fail "No server address. Copy the whole line from the app rather than just this URL."
}
$server = $server.TrimEnd('/')
if ($server -notmatch '^https?://[A-Za-z0-9.:_-]+$') {
  Fail "That server address does not look right: $server"
}

$repo = $env:AIR_REPO
if (-not $repo) {
  Fail "No source address. Copy the whole line from the app rather than just this URL."
}

# ── who is this computer about to answer to? ──────────────────────────
#
# Asked before anything is installed, and answered out loud. A setup token
# travels toward a machine, which means somebody can be handed one and told it
# does something else - and the only defence is telling the person at the
# keyboard exactly whose account is about to get the files, the shell and the
# screen of this computer.

try {
  $preview = Invoke-RestMethod -Method Post -Uri "$server/api/pair/enrol" `
    -ContentType 'application/json' -Body (@{ token = $token } | ConvertTo-Json)
} catch {
  Fail "That setup link is not valid any more. Get a new one from the app. ($($_.Exception.Message))"
}

Write-Host ""
Write-Host "  This will give  $($preview.account)  full access to this computer:" -ForegroundColor Yellow
Write-Host "  its files, a shell, and control of your screen." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Continue only if that is your own account."
Write-Host ""
$answer = Read-Host "  Type YES to continue"
if ($answer -ne 'YES') { Fail "Stopped. Nothing was installed and nothing was given away." }

# ── the things that have to already be here ───────────────────────────

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js is not installed. Get it from nodejs.org (version 20 or newer), then run this again."
}
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { Fail "This needs Node 20 or newer. You have $(node -v)." }

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Fail "Git is not installed. Get it from git-scm.com, then run this again."
}

# ── where it lives ────────────────────────────────────────────────────
#
# Under LOCALAPPDATA rather than Documents or the desktop: this is a program,
# not a document, and it should not be sitting in a folder somebody syncs.

$root = $env:AIR_HOME
if (-not $root) { $root = Join-Path $env:LOCALAPPDATA 'AI-Remote' }

if (Test-Path (Join-Path $root '.git')) {
  Say "Updating the copy already in $root"
  # Not fatal: a local change or a diverged branch is a reason to leave the copy
  # alone, not a reason to refuse to connect the computer.
  $ErrorActionPreference = 'Continue'
  & git -C $root pull --ff-only 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
} else {
  Say "Downloading into $root"
  Run 'Downloading the source' 'git' @('clone', '--depth', '1', $repo, $root)
}

Say "Installing dependencies (this takes a minute)"
Push-Location $root
try {
  # npm.cmd on Windows, and it writes plenty to stderr that is not an error.
  Run 'npm install' 'npm' @('install', '--no-audit', '--no-fund')
} finally {
  Pop-Location
}

# ── redeem the token ──────────────────────────────────────────────────

$info = @{ platform = "win32 $env:PROCESSOR_ARCHITECTURE"; hostname = $env:COMPUTERNAME }
try {
  $paired = Invoke-RestMethod -Method Post -Uri "$server/api/pair/enrol" -ContentType 'application/json' `
    -Body (@{ token = $token; confirm = $true; name = $env:COMPUTERNAME; info = $info } | ConvertTo-Json)
} catch {
  Fail "Could not finish setup: $($_.Exception.Message)"
}

$workerEnv = Join-Path $root 'worker\.env'
$lines = @(
  '# Written by setup. Delete WORKER_TOKEN to pair this computer again.',
  "SERVER_URL=$server",
  "WORKER_TOKEN=$($paired.token)"
)
Set-Content -Path $workerEnv -Value $lines -Encoding utf8

# The token is a live credential for this computer. Nobody needs it in their
# scrollback, and leaving it there is how it ends up in a screenshot.
$env:AIR_TOKEN = $null
Clear-Variable token

Say "Paired as `"$($paired.name)`"."

# ── start it, and keep starting it ────────────────────────────────────

Push-Location $root
try {
  # Its own output is worth showing — it names the command that undoes it. Not
  # fatal either: the computer is paired by this point, and failing to arrange a
  # restart at login is not a reason to say the whole setup failed.
  $ErrorActionPreference = 'Continue'
  & node scripts/autostart.js --install 2>&1 | ForEach-Object { Say $_ }
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "  Done. This computer is now yours from any device you sign in on." -ForegroundColor Green
Write-Host "  $server"
Write-Host ""
Write-Host "  To stop it running at login:  node `"$root\scripts\autostart.js`" --uninstall"
Write-Host ""
