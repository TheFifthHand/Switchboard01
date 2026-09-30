# SWITCHBOARD / 01 - local launcher for Windows (PowerShell 5.1+, built into Windows 10/11).
#
# Serves ONLY the packaged app folder, ONLY on the loopback interface (127.0.0.1),
# then opens your default browser. Nothing is uploaded anywhere.
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

# Find a free loopback port, starting at $Port.
$listener = $null
for ($p = $Port; $p -lt ($Port + 20); $p++) {
  try {
    $candidate = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
    $candidate.Start()
    $listener = $candidate
    $Port = $p
    break
  } catch { }
}
if (-not $listener) {
  Write-Host "No free port between $Port and $($Port + 19). Close other copies of SWITCHBOARD and try again." -ForegroundColor Red
  exit 1
}

$url = "http://127.0.0.1:$Port/"
Write-Host ''
Write-Host '  SWITCHBOARD / 01' -ForegroundColor Yellow
Write-Host "  Running at $url  (this computer only)"
Write-Host '  Keep this window open while you play. Close it or press Ctrl+C to stop.'
Write-Host ''
if (-not $NoOpen) { Start-Process $url }

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
  Write-Host 'SWITCHBOARD / 01 stopped.'
}
