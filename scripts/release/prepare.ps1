param(
  [ValidateSet("test", "staging", "production")]
  [string]$Environment = "production",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
Push-Location $repoRoot
try {
  $status = @(git status --porcelain)
  if ($status.Count -gt 0) {
    throw "发布必须从干净工作树开始。请先提交或明确处理以下改动：`n$($status -join "`n")"
  }

  $commit = (git rev-parse HEAD).Trim()
  if ($commit -notmatch "^[0-9a-f]{40}$") { throw "无法读取完整 Git commit" }
  if (-not $Version) {
    $Version = "{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyy.MM.dd.HHmm"), $commit.Substring(0, 7)
  }
  $deployedAt = [DateTimeOffset]::UtcNow.ToString("o")
  $manifest = [ordered]@{
    version = $Version
    commit = $commit
    deployed_at = $deployedAt
    environment = $Environment
    service = "signin"
  }

  $releaseRoot = Join-Path ([IO.Path]::GetTempPath()) ("signin-release-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot "cloudfunc") -Destination (Join-Path $releaseRoot "cloudfunc") -Recurse
  Copy-Item -LiteralPath (Join-Path $repoRoot "public") -Destination (Join-Path $releaseRoot "public") -Recurse
  $json = $manifest | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText((Join-Path $releaseRoot "cloudfunc\build-info.json"), $json, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $releaseRoot "public\build-info.json"), $json, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $releaseRoot "release-manifest.json"), $json, [Text.UTF8Encoding]::new($false))

  Write-Output ("RELEASE_ROOT={0}" -f $releaseRoot)
  Write-Output ("CLOUDFUNC_DIR={0}" -f (Join-Path $releaseRoot "cloudfunc"))
  Write-Output ("PUBLIC_DIR={0}" -f (Join-Path $releaseRoot "public"))
  Write-Output ("COMMIT={0}" -f $commit)
  Write-Output ("VERSION={0}" -f $Version)
  Write-Output ("DEPLOYED_AT={0}" -f $deployedAt)
}
finally {
  Pop-Location
}
