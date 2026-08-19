# Bumps the version, builds, tags, and cuts a GitHub release.
#
#   .\scripts\release.ps1              # asks which part of the version to bump
#   .\scripts\release.ps1 -Bump minor  # non-interactive
#   .\scripts\release.ps1 -Bump none   # re-release the current version
#   .\scripts\release.ps1 -DryRun      # show what would happen, touch nothing
#
# package.json is the single source of truth: bumping rewrites it, and
# scripts/version.mjs carries the number into the binary and the status bar.
#
# This publishes, so it confirms before touching anything.

param(
    [ValidateSet("major", "minor", "patch", "none")]
    [string]$Bump,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail([string]$message) {
    Write-Host $message -ForegroundColor Red
    exit 1
}

function Get-Bumped([string]$current, [string]$part) {
    if ($part -eq "none") { return $current }
    $bits = $current.Split(".")
    if ($bits.Count -ne 3) { Fail "version '$current' is not major.minor.patch" }
    $major = [int]$bits[0]; $minor = [int]$bits[1]; $patch = [int]$bits[2]
    switch ($part) {
        "major" { $major++; $minor = 0; $patch = 0 }
        "minor" { $minor++; $patch = 0 }
        "patch" { $patch++ }
    }
    return "$major.$minor.$patch"
}

# --- where are we -----------------------------------------------------------

$pkgPath = Join-Path $root "package.json"
if (-not (Test-Path $pkgPath)) { Fail "no package.json here - run this from the gitc repo" }
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$current = $pkg.version

$dirty = git status --porcelain
if ($dirty -and -not $DryRun) {
    Fail "working tree is not clean - commit or stash first:`n$dirty"
}

if (-not $Bump) {
    Write-Host "Current version: $current" -ForegroundColor Cyan
    $answer = Read-Host "Bump which part? [major/minor/patch/none]"
    if (-not $answer) { $answer = "patch" }
    $Bump = $answer.ToLower()
}
if ($Bump -notin @("major", "minor", "patch", "none")) { Fail "unknown bump '$Bump'" }

$next = Get-Bumped $current $Bump
$tag = "v$next"

# owner/repo from the remote, so this is not hardcoded to one fork.
$remote = git remote get-url origin
if ($remote -match "github\.com[:/](.+?)(\.git)?$") { $repo = $Matches[1] }
else { Fail "cannot read owner/repo from remote '$remote'" }

Write-Host ""
Write-Host "  repo     $repo"
Write-Host "  version  $current -> $next"
Write-Host "  tag      $tag"
if ($DryRun) { Write-Host "  DRY RUN - nothing will be written" -ForegroundColor Yellow }
Write-Host ""

if (git tag --list $tag) { Fail "tag $tag already exists" }

if (-not $DryRun) {
    $go = Read-Host "Publish? [y/N]"
    if ($go -ne "y") { Write-Host "Cancelled."; exit 0 }
}

# --- apply, build, verify ---------------------------------------------------

if ($next -ne $current) {
    Write-Host "Setting version to $next" -ForegroundColor Cyan
    if (-not $DryRun) {
        # Rewrite only the version line: a full ConvertTo-Json round trip
        # reorders and re-indents the whole file for no reason.
        $raw = Get-Content $pkgPath -Raw
        $raw = $raw -replace '("version"\s*:\s*")[^"]+(")', "`${1}$next`${2}"
        Set-Content $pkgPath $raw -NoNewline -Encoding utf8
    }
}

Write-Host "Building" -ForegroundColor Cyan
if (-not $DryRun) {
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "build failed - nothing has been tagged" }

    $exe = Join-Path $root "dist\gitc.exe"
    if (-not (Test-Path $exe)) { Fail "build produced no dist\gitc.exe" }

    # The binary must agree with package.json, or the release lies about itself.
    $reported = (& $exe --version) -join ""
    if ($reported -notmatch [regex]::Escape($next)) {
        Fail "binary reports '$reported' but package.json says $next"
    }
    Write-Host "  $reported" -ForegroundColor Green

    $hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
    $size = "{0:N1} MB" -f ((Get-Item $exe).Length / 1MB)
    Write-Host "  $size, sha256 $hash"
}

# --- commit, tag, publish ---------------------------------------------------

if ($DryRun) {
    Write-Host "`nDry run complete - no commit, tag or release was made." -ForegroundColor Yellow
    exit 0
}

if ($next -ne $current) {
    git add package.json
    git commit -m "Release $tag"
    if ($LASTEXITCODE -ne 0) { Fail "commit failed" }
}

git tag -a $tag -m "gitc $next"
git push origin HEAD
git push origin $tag

$notes = @"
## gitc $next

A fast, minimal git client - commit graph, branching, rebase and conflict
resolution in a single native binary.

### Download

Attached below: ``gitc.exe`` (Windows x64).

### Checksum (SHA-256)

``````
$hash  gitc.exe
``````
"@

$notesPath = Join-Path $root "dist\RELEASE_NOTES.md"
Set-Content $notesPath $notes -Encoding utf8

gh release create $tag (Join-Path $root "dist\gitc.exe") `
    --repo $repo --title "gitc $next" --notes-file $notesPath
if ($LASTEXITCODE -ne 0) { Fail "gh release failed - the tag is pushed, so re-run with -Bump none" }

Write-Host "`nPublished https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
Write-Host "Remember to point gitc-dev at the new submodule commit." -ForegroundColor Yellow
