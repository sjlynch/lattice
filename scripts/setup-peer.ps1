# Install or update Lattice on another Windows PC (say, the GPU PC) so Fleet
# on your main PC can pair with it. Run in PowerShell on that PC:
#
#   irm https://raw.githubusercontent.com/sjlynch/lattice/main/scripts/setup-peer.ps1 | iex
#
# or, from a checkout:  powershell -ExecutionPolicy Bypass -File scripts\setup-peer.ps1 [-Dir C:\path]
#
# It clones (or fast-forwards) the repo, installs dependencies and prints the
# pairing steps. It never starts Lattice for you and changes no settings:
# the gateway stays off until you switch it on in Fleet -> PCs.

param([string]$Dir = (Join-Path $env:USERPROFILE 'lattice'))
$ErrorActionPreference = 'Stop'

function Need($tool, $hint) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH. $hint" }
}
Need git 'Install Git for Windows: https://git-scm.com/download/win'
Need node 'Install Node.js 22.13+ or 24+: https://nodejs.org/'
Need npm 'npm ships with Node.js.'

$v = (node -p "process.versions.node").Trim().Split('.') | ForEach-Object { [int]$_ }
$okNode = ($v[0] -ge 24) -or ($v[0] -eq 22 -and $v[1] -ge 13) -or ($v[0] -eq 20 -and $v[1] -ge 19)
if (-not $okNode) { throw "Node $($v -join '.') is too old: Lattice needs 20.19+, 22.13+ or 24+." }

if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "Updating $Dir"
  git -C $Dir pull --ff-only
} else {
  Write-Host "Cloning Lattice into $Dir"
  git clone https://github.com/sjlynch/lattice.git $Dir
}
Set-Location $Dir
npm run install:all

$harnesses = @('claude', 'codex', 'pi') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }
Write-Host ''
Write-Host "Lattice is ready in $Dir. Agent CLIs found: $(if ($harnesses) { $harnesses -join ', ' } else { 'none (install claude, codex or pi to run agents here)' })"
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. npm run dev            (in this folder; then open http://localhost:5183)'
Write-Host '  2. Fleet (top bar) -> PCs -> tick "Let paired PCs connect to this one".'
Write-Host '     Windows may ask to let Node.js through the firewall: allow it on Private networks.'
Write-Host '  3. Create an invite named after your main PC (scope "operate" to run tasks here),'
Write-Host '     copy the lattice-peer:1:... string, and on the main PC paste it in Fleet -> PCs -> Pair.'
Write-Host '     "Find PCs on this network" on the main PC lists this one once its gateway is on.'
