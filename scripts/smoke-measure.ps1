<#
  Measures four success criteria on the real Cloudflare account, through the packed `everport` CLI (Windows).

  first-add  first `add` -> the address answers, with a COLD npm cache (wrangler is downloaded again). `login` is a human step.
  restart  `down`, then `up`: the old address answers again.
  crash-recovery  the agent is killed without any cleanup, then `up`: the old address answers again.
  host-killed  the host that started the agent is killed with its whole process tree: the tunnel keeps answering.

  Creates a Worker called ep-smoke-<random> and removes it again, whatever happens. ~3 minutes.
  Needs: Node 22+ on PATH, `wrangler login` already done, port 5599 free. Run from the repo root:
    powershell -File scripts\smoke-measure.ps1
#>
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$nodeDir = Split-Path -Parent $node
$work = Join-Path $env:TEMP "everport-rs-smoke-$(Get-Random)"
New-Item -ItemType Directory $work | Out-Null
$workerName = 'ep-smoke-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
$port = 5599
$body = 'hello from the r-s smoke'
$origin = $null
$host2 = $null
$failures = 0
$started = Get-Date
$table = @()

function Say($text) { '[{0,4}s] {1}' -f [int]((Get-Date) - $started).TotalSeconds, $text }
function Expect($what, $ok) {
  if ($ok) { Say "ok    $what" } else { Say "FAIL  $what"; $script:failures++ }
}
function Record($id, $what, $seconds, $limit) {
  $verdict = if ($seconds -le $limit) { 'pass' } else { 'OVER' }
  if ($verdict -eq 'OVER') { $script:failures++ }
  $script:table += ('{0,-15} {1,-62} {2,7:N1} s   limit {3} s   {4}' -f $id, $what, $seconds, $limit, $verdict)
  Say ('measured {0}: {1:N1} s (limit {2} s) {3}' -f $id, $seconds, $limit, $verdict)
}
function Answers($url) { (curl.exe -s -m 10 $url) -eq $body }
# Seconds until the address answers, polling every 0.5 s; $null when it does not within $maxSeconds.
function WaitAnswers($url, $maxSeconds) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  while ($t.Elapsed.TotalSeconds -lt $maxSeconds) {
    if (Answers $url) { return $t.Elapsed.TotalSeconds }
    Start-Sleep -Milliseconds 500
  }
  return $null
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
# first-add is measured with wrangler not cached, as on a new computer. Everything after it uses this same cache.
$env:npm_config_cache = Join-Path $work 'npm-cache'

function Ep([string[]]$arguments) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $text = (& $cli @arguments 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $secs = $watch.Elapsed.TotalSeconds
  Say ("`$ everport $($arguments -join ' ')   [exit $code, {0:N1} s]" -f $secs)
  ($text.TrimEnd() -split "`r?`n") | ForEach-Object { "      $_" }
  @{ Code = $code; Out = $text; Seconds = $secs }
}
function AgentPid { try { (Get-Content (Join-Path $dataDir 'agent.json') -Raw | ConvertFrom-Json).pid } catch { $null } }
function Alive($processId) { $null -ne $processId -and $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue) }

try {
  Set-Content (Join-Path $work 'origin.mjs') "import { createServer } from 'node:http'; createServer((q, r) => r.end('$body')).listen($port, '127.0.0.1');"
  $origin = Start-Process -FilePath $node -ArgumentList (Join-Path $work 'origin.mjs') -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 1

  # first-add
  $r = Ep @('add', "$port", '--label', 'fe')
  $url = ($r.Out -split "`r?`n" | Where-Object { $_ -match '^https://fe-.*\.workers\.dev$' } | Select-Object -First 1)
  Expect "the first add works and the address answers ($url)" ($r.Code -eq 0 -and (Answers $url))
  Record 'first-add' 'first add to a working address, cold wrangler cache (no login)' $r.Seconds 300

  # restart
  Ep @('down') | Out-Null
  $r = Ep @('up')
  Expect 'restart: the old address answers after down and up' (Answers $url)
  Record 'restart' 'up after a clean down, command time' $r.Seconds 5

  # crash-recovery
  $old = AgentPid
  Expect "an agent is running (pid $old)" (Alive $old)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  taskkill /F /T /PID $old 2>&1 | Out-Null
  Start-Sleep -Seconds 1
  Expect 'the agent is dead' (-not (Alive $old))
  Expect 'the address no longer answers' (-not (Answers $url))
  $r = Ep @('up')
  $wait = WaitAnswers $url 60
  Expect 'crash-recovery: the old address answers after the crash and up, nothing done by hand' ($null -ne $wait)
  Record 'crash-recovery' 'from the kill to the old address answering (includes 1 s wait)' $watch.Elapsed.TotalSeconds 60
  $new = AgentPid
  Expect "the agent is a new process (pid $new)" ((Alive $new) -and $new -ne $old)

  # host-killed: a host process (stands for VS Code or a terminal) starts the agent; then its whole tree is killed.
  Ep @('down') | Out-Null
  $hostScript = Join-Path $work 'host.ps1'
  Set-Content $hostScript "& '$cli' up; Start-Sleep -Seconds 600"
  $host2 = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile', '-File', $hostScript -PassThru -WindowStyle Hidden
  $wait = WaitAnswers $url 60
  Expect 'the host started the agent and the address answers' ($null -ne $wait)
  $agent = AgentPid
  taskkill /F /T /PID $host2.Id 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  Expect 'the host is gone' (-not (Alive $host2.Id))
  Expect "host-killed: the agent survived the host's death (pid $agent)" (Alive $agent)
  Expect 'host-killed: the address still answers' (Answers $url)
  $table += 'host-killed  host killed with its whole process tree: tunnel keeps answering   (see the two lines above)'
  Ep @('rm', 'fe') | Out-Null
  Ep @('down') | Out-Null
}
finally {
  Say 'cleaning up'
  & $cli down 2>&1 | Out-Null
  if ($host2) { taskkill /F /T /PID $host2.Id 2>&1 | Out-Null }
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
  $left = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*agent.js*' -or $_.CommandLine -like '*origin.mjs*' -or $_.CommandLine -like '*host.ps1*' } | Measure-Object).Count
  Expect 'no agent, host or test service is left running' ($left -eq 0)
}

''
$table
Say "done: $failures failure(s)"
exit $failures
