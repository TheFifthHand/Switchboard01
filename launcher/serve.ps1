# Omni Song - local launcher for Windows (PowerShell 5.1+, built into Windows 10/11).
#
# Serves ONLY the packaged app folder, ONLY on the loopback interface (127.0.0.1),
# then opens your default browser. Nothing is uploaded anywhere.
#
# The browser keeps projects per address, and the port is part of the address,
# so the launcher stays on one port. If Omni Song already runs there, the version
# its page names decides: the same version as this one is opened and this window
# closes; another version (or SWITCHBOARD / 01, the app's name before 2.0) is
# named, and this window waits until that copy's window is closed, then starts
# this version at the same address. If another program holds the port it explains
# what that means for saved projects before using the next free port.
# serve.mjs (the Node launcher) behaves and words this the same way.
#
# Stop: close this window, or press Ctrl+C.
param(
  [string]$Root = '',
  [int]$Port = 4173,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path (Split-Path -Parent $PSScriptRoot) 'app' }
if (-not (Test-Path -LiteralPath (Join-Path $Root 'index.html'))) {
  Write-Host "Cannot find index.html in '$Root'." -ForegroundColor Red
  Write-Host 'Make sure you extracted the whole zip and kept the "app" folder next to this launcher.'
  exit 1
}
$sep = [System.IO.Path]::DirectorySeparatorChar
$Root = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root).Path).TrimEnd($sep)

$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.woff2' = 'font/woff2'; '.woff' = 'font/woff'
  '.wav' = 'audio/wav'; '.map' = 'application/json; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'
}

function Start-Listener([int]$p) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
    $l.Start()
    return $l
  } catch { return $null }
}

# The version a page names (its omni-song-version meta, see vite.config.ts), or ''
# (built before 2.3, or not ours).
function Get-PageVersion([string]$html) {
  $tag = [regex]::Match($html, '<meta\b[^>]*\bname=["'']?omni-song-version\b[^>]*>', 'IgnoreCase')
  if (-not $tag.Success) { return '' }
  $m = [regex]::Match($tag.Value, '\bcontent=["'']?([^"''\s>]+)', 'IgnoreCase')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

function Get-VersionName([string]$v) {
  if ($v) { return "version $v" }
  return 'an older version'
}

# Which copy of the app answers on port $p (another launcher window, or any server of the app):
# @{ App = 'current' (Omni Song) or 'older' (SWITCHBOARD / 01, the same app before 2.0);
#    Version = the version its page names, or '' } or $null (nothing of ours).
# Reads to the end of the page's head, where the version is. Another launcher window
# answers one connection at a time and gives an idle browser connection up to 3 s,
# so wait longer than that for the page.
function Test-App([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect([System.Net.IPAddress]::Loopback, $p, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(1500)) { return $null }
    $client.EndConnect($pending)
    $client.ReceiveTimeout = 6000
    $net = $client.GetStream()
    $ask = [System.Text.Encoding]::ASCII.GetBytes("GET / HTTP/1.0`r`nHost: 127.0.0.1:$p`r`nConnection: close`r`n`r`n")
    $net.Write($ask, 0, $ask.Length)
    $buffer = New-Object byte[] 16384
    $text = ''
    while ($text.Length -lt 262144) {
      $n = $net.Read($buffer, 0, $buffer.Length)
      if ($n -le 0) { break }
      $text += [System.Text.Encoding]::UTF8.GetString($buffer, 0, $n)
      if ($text.IndexOf('</head>', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { break }
    }
    $app = ''
    if ($text.Contains('<title>Omni Song</title>')) { $app = 'current' }
    elseif ($text.Contains('<title>SWITCHBOARD / 01</title>')) { $app = 'older' }
    if (-not $app) { return $null }
    return @{ App = $app; Version = (Get-PageVersion $text) }
  } catch {
    return $null
  } finally {
    $client.Close()
  }
}

# The window's title names the version, so two launcher windows can be told apart.
function Set-Title([string]$t) {
  try { $Host.UI.RawUI.WindowTitle = $t } catch { }
}

function Open-Browser([string]$u) {
  if ($NoOpen) { return }
  try { Start-Process $u } catch { Write-Host "  Open $u in your browser." }
}

# This copy's version, named by the page it serves.
$ownVersion = Get-PageVersion ([System.IO.File]::ReadAllText((Join-Path $Root 'index.html')))
$titled = if ($ownVersion) { "Omni Song $ownVersion" } else { 'Omni Song' }

$usual = "http://127.0.0.1:$Port/"
$listener = $null
for ($p = $Port; $p -le ($Port + 19); $p++) {
  $listener = Start-Listener $p
  if ($listener) { break }
  $running = Test-App $p
  if ($null -ne $running) {
    $url = "http://127.0.0.1:$p/"
    Write-Host ''
    $note = if ($p -ne $Port) { " (not the usual $usual)" } else { '' }
    if ($running.App -eq 'current' -and $running.Version -eq $ownVersion) {
      Write-Host "  Omni Song is already running at $url$note" -ForegroundColor Yellow
      Write-Host '  The window (or program) that started it keeps it running.'
      if ($NoOpen) { Write-Host "  Open $url in your browser." } else { Write-Host '  Opening it in your browser.' }
      Write-Host ''
      Open-Browser $url
      # Time to read this before the window closes by itself.
      if (-not $NoOpen) { Start-Sleep -Seconds 4 }
      exit 0
    }
    # Another version: projects belong to this address, so wait for it rather than move.
    if ($running.App -eq 'older') {
      $other = 'An older version of this app (SWITCHBOARD / 01)'
      $otherWindow = 'SWITCHBOARD / 01'
    } else {
      $other = "Another copy of Omni Song ($(Get-VersionName $running.Version))"
      $otherWindow = 'Omni Song'
    }
    $then = if ($ownVersion) { "version $ownVersion" } else { 'this version' }
    Set-Title "$titled - waiting"
    Write-Host "  $other is running in another window," -ForegroundColor Yellow
    Write-Host "  at $url$note" -ForegroundColor Yellow
    Write-Host "  This is $(Get-VersionName $ownVersion). Close the other small black $otherWindow window"
    Write-Host "  (or press Ctrl+C in it): this window then starts $then by itself,"
    Write-Host '  at the same address, so all your projects are there.'
    Write-Host '  Waiting for the other copy to stop...'
    # Every few seconds, also look at what answers: this version started there
    # meanwhile (a second double-click, say) is opened instead.
    $tries = 0
    while (-not $listener) {
      Start-Sleep -Seconds 1
      $listener = Start-Listener $p
      $tries++
      if (-not $listener -and $tries % 3 -eq 0) {
        $now = Test-App $p
        if ($null -ne $now -and $now.App -eq 'current' -and $now.Version -eq $ownVersion) {
          Write-Host ''
          Write-Host "  Omni Song $(Get-VersionName $ownVersion) is now running at $url$note" -ForegroundColor Yellow
          Write-Host '  The window (or program) that started it keeps it running.'
          if ($NoOpen) { Write-Host "  Open $url in your browser." } else { Write-Host '  Opening it in your browser.' }
          Write-Host ''
          Open-Browser $url
          if (-not $NoOpen) { Start-Sleep -Seconds 4 }
          exit 0
        }
      }
    }
    Write-Host ''
    Write-Host '  The other copy has stopped.'
    break
  }
  if ($p -eq $Port) {
    Write-Host ''
    Write-Host "  Port $p is used by another program (or reserved by Windows), so Omni Song" -ForegroundColor Yellow
    Write-Host "  cannot open at its usual address $usual" -ForegroundColor Yellow
    Write-Host '  Your browser keeps projects separately for each address. Projects saved at'
    Write-Host "  $usual will not appear in My projects at another address (they are"
    Write-Host '  not deleted), and projects saved at another address stay with that address.'
    Write-Host "  To use the usual address: close this window, close the program that uses port $p"
    Write-Host '  (or restart the computer), then start Omni Song again. To move a project between'
    Write-Host '  addresses, use "Export this project" and "Import project file..." in the Project library.'
    Write-Host ''
    if (-not $NoOpen -and -not [Console]::IsInputRedirected) {
      $null = Read-Host '  Press Enter to open Omni Song at another address, or close this window to stop'
    }
  }
}
if (-not $listener) {
  Write-Host "No free port between $Port and $($Port + 19). Close other copies of Omni Song and try again." -ForegroundColor Red
  exit 1
}
$preferred = $Port
$Port = $p

$url = "http://127.0.0.1:$Port/"
Set-Title $titled
Write-Host ''
Write-Host '  Omni Song' -ForegroundColor Yellow
if ($Port -eq $preferred) {
  Write-Host "  Running at $url  (this computer only)"
} else {
  Write-Host "  Running at $url  (this computer only; not the usual $usual)"
}
Write-Host '  Keep this window open while you play. Close it or press Ctrl+C to stop.'
Write-Host ''
Open-Browser $url

function Send-Response($stream, [int]$code, [string]$status, [string]$type, [byte[]]$body, [bool]$headOnly) {
  $header = "HTTP/1.1 $code $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($hb, 0, $hb.Length)
  if (-not $headOnly -and $body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

try {
  while ($true) {
    # Poll so Ctrl+C stays responsive.
    while (-not $listener.Pending()) { Start-Sleep -Milliseconds 20 }
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 3000
      $client.SendTimeout = 10000
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)
      $requestLine = $reader.ReadLine()
      if (-not $requestLine) { continue }
      while ($true) { $h = $reader.ReadLine(); if ($null -eq $h -or $h -eq '') { break } }
      $parts = $requestLine.Split(' ')
      $method = $parts[0]
      $headOnly = $method -eq 'HEAD'
      if ($parts.Length -lt 2 -or ($method -ne 'GET' -and -not $headOnly)) {
        Send-Response $stream 405 'Method Not Allowed' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes('Method not allowed')) $false
        continue
      }
      $path = [System.Uri]::UnescapeDataString(($parts[1].Split('?')[0]).Split('#')[0])
      if ($path.EndsWith('/')) { $path += 'index.html' }
      $relative = $path.TrimStart('/').Replace('/', [string]$sep)
      $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $relative))
      if (-not $full.StartsWith($Root + $sep, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Response $stream 403 'Forbidden' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes('Forbidden')) $headOnly
        continue
      }
      if (-not [System.IO.File]::Exists($full)) {
        if ([System.IO.Path]::GetExtension($full) -eq '') {
          $full = [System.IO.Path]::Combine($Root, 'index.html')
        } else {
          Send-Response $stream 404 'Not Found' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes('Not found')) $headOnly
          continue
        }
      }
      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $type = $types[$ext]
      if (-not $type) { $type = 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      Send-Response $stream 200 'OK' $type $bytes $headOnly
    } catch {
      # A browser closing a connection early is normal; keep serving.
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
  Write-Host 'Omni Song stopped.'
}
