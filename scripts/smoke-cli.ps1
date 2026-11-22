<#
  Smoke test of the packed CLI on the real Cloudflare account (Windows, PowerShell).

  It builds and packs the `everport` package, installs the tarball into an empty folder as a user would, and runs the
  whole flow through the installed `everport` command: add, ls, down, up, stop, start, copy, rm, doctor.
  It creates a Worker called ep-smoke-<random> and removes it again, whatever happens.

  Needs: Node 22+ on PATH, `wrangler login` already done (run `everport login`), no other service on port 5599.
  Run from the repo root:   powershell -File scripts\smoke-cli.ps1
#>
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$nodeDir = Split-Path -Parent $node
$work = Join-Path $env:TEMP "everport-cli-smoke-$(Get-Random)"
New-Item -ItemType Directory $work | Out-Null
$workerName = 'ep-smoke-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
$port = 5599
$origin = $null
$failures = 0
$started = Get-Date

function Say($text) { '[{0,4}s] {1}' -f [int]((Get-Date) - $started).TotalSeconds, $text }
function Expect($what, $ok) {
  if ($ok) { Say "ok    $what" } else { Say "FAIL  $what"; $script:failures++ }
}

Set-Location $repo
Say "Worker for this smoke test: $workerName"
npm run build -w everport 2>&1 | Out-Null
npm pack -w everport --pack-destination $work 2>&1 | Out-Null
$tgz = Get-ChildItem $work -Filter 'everport-*.tgz' | Select-Object -First 1
Expect 'the package was packed' ($null -ne $tgz)

$inst = Join-Path $work 'install'
New-Item -ItemType Directory $inst | Out-Null
Set-Location $inst
npm init -y 2>&1 | Out-Null
npm install $tgz.FullName 2>&1 | Out-Null
$files = (Get-ChildItem (Join-Path $inst 'node_modules\everport\dist') | ForEach-Object Name) -join ','
Expect "the package holds the CLI, the agent and the Worker ($files)" ($files -eq 'agent.js,everport.js,worker.js')
$cli = Join-Path $inst 'node_modules\.bin\everport.cmd'

$env:EVERPORT_DATA_DIR = Join-Path $work 'data'
$env:EVERPORT_WORKER_NAME = $workerName

# Runs the installed command and returns @{ Code; Out } (stderr and stdout together).
function Ep([string[]]$arguments) {
  $text = (& $cli @arguments 2>&1 | Out-String)
  $code = $LASTEXITCODE
  Say "`$ everport $($arguments -join ' ')   [exit $code]"
  ($text.TrimEnd() -split "`r?`n") | ForEach-Object { "      $_" }
  @{ Code = $code; Out = $text }
}

try {
  Set-Content (Join-Path $work 'origin.mjs') "import { createServer } from 'node:http'; createServer((q, r) => r.end('hello from the cli smoke')).listen($port, '127.0.0.1');"
  $origin = Start-Process -FilePath $node -ArgumentList (Join-Path $work 'origin.mjs') -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 1

  $r = Ep @('--version');   Expect 'version names Everport and wrangler' ($r.Out -match 'everport \S+ \(wrangler \d')
  $r = Ep @('nonsense');    Expect 'an unknown command is a usage error' ($r.Code -eq 2)
  $r = Ep @('ls');          Expect 'ls starts empty' ($r.Out -match 'No tunnels yet')
  $r = Ep @('doctor');      Expect 'doctor passes' ($r.Code -eq 0)

  $r = Ep @('add', "$port", '--label', 'fe')
  Expect 'the first add works' ($r.Code -eq 0)
  Expect 'the first add warns about the workers.dev subdomain' ($r.Out -match 'workers\.dev subdomain')
  $url = ($r.Out -split "`r?`n" | Where-Object { $_ -match '^https://fe-.*\.workers\.dev$' } | Select-Object -First 1)
  Expect "the address answers ($url)" ((curl.exe -s -m 20 $url) -eq 'hello from the cli smoke')

  $r = Ep @('ls', '--health'); Expect 'health is ok' ($r.Out -match '\bactive\s+ok\b')
  $r = Ep @('add', "$port", '--label', 'fe'); Expect 'a duplicate label is refused' ($r.Code -eq 1 -and $r.Out -match 'already exists')

  $r = Ep @('down')
  Expect 'down stops the tunnel' ((curl.exe -s -m 20 -o NUL -w '%{http_code}' $url) -eq '503')
  $r = Ep @('up')
  Expect 'up brings it back at the same address' ((curl.exe -s -m 20 $url) -eq 'hello from the cli smoke')
  $r = Ep @('stop', 'fe');  Expect 'stop says stopped' ($r.Out -match 'stopped')
  $r = Ep @('start', 'fe'); Expect 'start says active' ($r.Out -match 'active')
  $r = Ep @('copy', 'fe');  Expect 'copy prints the address' ($r.Out -match [regex]::Escape($url))
  $r = Ep @('rm', 'fe');    Expect 'rm removes the tunnel' ($r.Code -eq 0)
  $r = Ep @('ls');          Expect 'ls is empty again' ($r.Out -match 'No tunnels yet')
  $r = Ep @('down')
}
finally {
  Say 'cleaning up'
  & $cli down 2>&1 | Out-Null
  if ($origin) { Stop-Process -Id $origin.Id -Force -ErrorAction SilentlyContinue }
  $env:CI = '1'
  $npx = Join-Path $nodeDir 'node_modules\npm\bin\npx-cli.js'
  $gone = $false
  for ($i = 0; $i -lt 6 -and -not $gone; $i++) {
    & $node $npx -y wrangler@4.166.0 delete --name $workerName --force 2>&1 | Out-Null
    $check = & $node $npx -y wrangler@4.166.0 versions list --name $workerName --json 2>&1 | Out-String
    $gone = $check -match '10007'
    if (-not $gone) { Start-Sleep -Seconds 2 }
  }
  Expect "the Worker $workerName is gone from the account" $gone
  Set-Location $repo
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  $left = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*agent.js*' -or $_.CommandLine -like '*origin.mjs*' } | Measure-Object).Count
  Expect 'no agent or test service is left running' ($left -eq 0)
}

Say "done: $failures failure(s)"
exit $failures
