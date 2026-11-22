<#
  Two checks on the real Cloudflare account, through the packed `everport` CLI (Windows):

  1. Closing the terminal window: a real console window starts `everport add`, the window is closed the way the X
     button does it (WM_CLOSE), and the tunnel must keep answering with its agent alive.
  2. Not logged in: with an empty user profile (so wrangler has no login, and your real login is untouched),
     `doctor` must fail with a hint, `add` must be refused with exit code 1, and nothing may be created.

  It creates a Worker called ep-smoke-<random> and removes it again, whatever happens. ~2 minutes.
  Needs: Node 22+ on PATH, `wrangler login` already done, port 5588 free. Run from the repo root:
    powershell -File scripts\smoke-close.ps1
#>
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$nodeDir = Split-Path -Parent $node
$work = Join-Path $env:TEMP "everport-close-smoke-$(Get-Random)"
New-Item -ItemType Directory $work | Out-Null
$workerName = 'ep-smoke-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
$port = 5588
$body = 'hello from the close smoke'
$origin = $null
$console = $null
$failures = 0
$started = Get-Date
$npmCache = (npm config get cache)

function Say($text) { '[{0,4}s] {1}' -f [int]((Get-Date) - $started).TotalSeconds, $text }
function Expect($what, $ok) {
  if ($ok) { Say "ok    $what" } else { Say "FAIL  $what"; $script:failures++ }
}
function Answers($url) { (curl.exe -s -m 10 $url) -eq $body }
function WaitAnswers($url, $maxSeconds) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  while ($t.Elapsed.TotalSeconds -lt $maxSeconds) {
    if (Answers $url) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

Set-Location $repo
Say "Worker for this run: $workerName"
npm run build -w everport 2>&1 | Out-Null
npm pack -w everport --pack-destination $work 2>&1 | Out-Null
$tgz = Get-ChildItem $work -Filter 'everport-*.tgz' | Select-Object -First 1
Expect 'the package was packed' ($null -ne $tgz)
$inst = Join-Path $work 'install'
New-Item -ItemType Directory $inst | Out-Null
Set-Location $inst
npm init -y 2>&1 | Out-Null
npm install $tgz.FullName 2>&1 | Out-Null
$cli = Join-Path $inst 'node_modules\.bin\everport.cmd'
$dataDir = Join-Path $work 'data'
$env:EVERPORT_DATA_DIR = $dataDir
$env:EVERPORT_WORKER_NAME = $workerName

function AgentPid { try { (Get-Content (Join-Path $dataDir 'agent.json') -Raw | ConvertFrom-Json).pid } catch { $null } }
function Alive($processId) { $null -ne $processId -and $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue) }

try {
  Set-Content (Join-Path $work 'origin.mjs') "import { createServer } from 'node:http'; createServer((q, r) => r.end('$body')).listen($port, '127.0.0.1');"
  $origin = Start-Process -FilePath $node -ArgumentList (Join-Path $work 'origin.mjs') -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 1

  # 2. Not logged in (first, so nothing exists yet): an empty profile hides the real wrangler login.
  $empty = Join-Path $work 'empty-profile'
  New-Item -ItemType Directory $empty | Out-Null
  $real = @{ USERPROFILE = $env:USERPROFILE; HOME = $env:HOME; APPDATA = $env:APPDATA; npm_config_cache = $env:npm_config_cache }
  $env:USERPROFILE = $empty; $env:HOME = $empty; $env:APPDATA = "$empty\AppData"; $env:npm_config_cache = $npmCache
  $doctor = (& $cli doctor 2>&1 | Out-String); $doctorCode = $LASTEXITCODE
  $add = (& $cli add $port --label t0 2>&1 | Out-String); $addCode = $LASTEXITCODE
  $ls = (& $cli ls 2>&1 | Out-String)
  $env:USERPROFILE = $real.USERPROFILE; $env:HOME = $real.HOME; $env:APPDATA = $real.APPDATA
  if ($null -ne $real.npm_config_cache) { $env:npm_config_cache = $real.npm_config_cache } else { Remove-Item Env:npm_config_cache -ErrorAction SilentlyContinue }
  Say ('doctor (not logged in) [exit {0}]:' -f $doctorCode); ($doctor.TrimEnd() -split "`r?`n") | ForEach-Object { "      $_" }
  Say ('add (not logged in) [exit {0}]:' -f $addCode); ($add.TrimEnd() -split "`r?`n") | ForEach-Object { "      $_" }
  Expect 'doctor reports the missing login with a hint' ($doctor -match 'FAIL\s+cloudflare login' -and $doctor -match 'everport login')
  Expect 'add is refused with exit code 1 and says not logged in' ($addCode -eq 1 -and $add -match 'not logged in')
  Expect 'nothing was created: no tunnels and no data file' (($ls -match 'No tunnels yet') -and -not (Test-Path (Join-Path $dataDir 'tunnels.json')))

  # 1. Close the terminal window. conhost gives a classic console window that WM_CLOSE can close.
  $hostScript = Join-Path $work 'host.ps1'
  Set-Content $hostScript "& '$cli' add $port --label t1 *> '$work\host.log'; Start-Sleep -Seconds 600"
  $console = Start-Process -FilePath conhost.exe -ArgumentList 'powershell.exe', '-NoProfile', '-File', $hostScript -PassThru
  $url = $null
  for ($i = 0; $i -lt 90 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    $m = Select-String -Path "$work\host.log" -Pattern '^https://t1-.*\.workers\.dev$' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $url = $m.Line.Trim() }
  }
  Expect "the add inside the console window printed an address ($url)" ($null -ne $url)
  $answered = $url -and (WaitAnswers $url 30)
  Expect 'the address answers' $answered
  if (-not $answered -and $url) {
    Say ('diagnosis: ' + ((curl.exe -s -m 10 -i $url) -join ' | '))
    Say ('origin direct: ' + (curl.exe -s -m 5 "http://127.0.0.1:$port"))
    & $cli ls --health 2>&1 | ForEach-Object { "      $_" }
  }
  $agent = AgentPid
  Expect "the agent is running (pid $agent)" (Alive $agent)
  $console.Refresh()
  if ($console.MainWindowHandle -eq 0) {
    # Windows Terminal is the default host here: its window is not the conhost process's, and closing the user's
    # terminal windows from a script would be unsafe. Close it by hand.
    Say 'SKIP  closing the window: this host has no classic console window to close'
  } else {
    $null = $console.CloseMainWindow()
    $console.WaitForExit(15000) | Out-Null
    Expect 'the console window closed' $console.HasExited
    Start-Sleep -Seconds 6
    Expect "the agent survived the window closing (pid $agent)" (Alive $agent)
    Expect 'the address still answers after the window closed' ($url -and (Answers $url))
  }
  & $cli rm t1 2>&1 | Out-Null
  & $cli down 2>&1 | Out-Null
}
finally {
  Say 'cleaning up'
  & $cli down 2>&1 | Out-Null
  if ($console -and -not $console.HasExited) { taskkill /F /T /PID $console.Id 2>&1 | Out-Null }
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
  $left = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$work*" } | Measure-Object).Count
  Expect 'no agent, console or test service is left running' ($left -eq 0)
}

Say "done: $failures failure(s)"
exit $failures
