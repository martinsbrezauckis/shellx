param(
  [Parameter(Mandatory = $true)][string]$StatePath,
  [Parameter(Mandatory = $true)][string]$TokenPath,
  [Parameter(Mandatory = $true)][string]$InstanceId,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [int]$MaxLifetimeSeconds = 60
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($MaxLifetimeSeconds -le 0 -or $MaxLifetimeSeconds -gt 300) {
  throw "MaxLifetimeSeconds must be between 1 and 300"
}
$token = (Get-Content -Raw -LiteralPath $TokenPath).Trim()
if ($token.Length -lt 32) { throw "Fixture token must contain at least 32 characters" }

function Write-FixtureResponse {
  param(
    [Parameter(Mandatory = $true)][IO.Stream]$Stream,
    [Parameter(Mandatory = $true)][int]$Status,
    [Parameter(Mandatory = $true)][string]$Reason,
    [Parameter(Mandatory = $true)][string]$Json
  )
  $body = [Text.UTF8Encoding]::new($false).GetBytes($Json)
  $head = [Text.Encoding]::ASCII.GetBytes(
    "HTTP/1.1 $Status $Reason`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
  )
  $Stream.Write($head, 0, $head.Length)
  $Stream.Write($body, 0, $body.Length)
  $Stream.Flush()
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse("127.0.0.1"), 0)
$listener.Start()
try {
  $endpoint = [Net.IPEndPoint]$listener.LocalEndpoint
  $process = Get-Process -Id $PID -ErrorAction Stop
  if (-not $process.Path) { throw "fixture process image is unavailable" }
  $state = [pscustomobject]@{
    pid = $PID
    port = $endpoint.Port
    executablePath = $process.Path
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($StatePath, $state, [Text.UTF8Encoding]::new($false))

  $deadline = [DateTime]::UtcNow.AddSeconds($MaxLifetimeSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not $listener.Pending()) {
      Start-Sleep -Milliseconds 20
      continue
    }
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 3000
      $client.SendTimeout = 3000
      $stream = $client.GetStream()
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      $headers = @{}
      while ($true) {
        $line = $reader.ReadLine()
        if ([string]::IsNullOrEmpty($line)) { break }
        $separator = $line.IndexOf(":")
        if ($separator -gt 0) {
          $headers[$line.Substring(0, $separator).Trim().ToLowerInvariant()] = $line.Substring($separator + 1).Trim()
        }
      }
      $parts = @($requestLine -split " ")
      $path = if ($parts.Count -ge 2) { $parts[1] } else { "" }
      if ($headers["authorization"] -ne "Bearer $token") {
        Write-FixtureResponse -Stream $stream -Status 401 -Reason "Unauthorized" -Json "{}"
      } elseif ($path -eq "/browser/state") {
        Write-FixtureResponse -Stream $stream -Status 200 -Reason "OK" -Json '{"ok":true}'
      } elseif ($path -eq "/health") {
        $health = [pscustomobject]@{
          ok = $true
          processId = $PID
          instanceId = $InstanceId
          appVersion = $Version
          buildCommit = $SourceCommit
          debugApiVersion = "1.2.0"
          debugApiPort = $endpoint.Port
        } | ConvertTo-Json -Compress
        Write-FixtureResponse -Stream $stream -Status 200 -Reason "OK" -Json $health
      } else {
        Write-FixtureResponse -Stream $stream -Status 404 -Reason "Not Found" -Json "{}"
      }
    } finally {
      $client.Dispose()
    }
  }
} finally {
  $listener.Stop()
}
