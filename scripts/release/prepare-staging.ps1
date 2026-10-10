param(
  [Parameter(Mandatory=$true)][string]$EnvId,
  [Parameter(Mandatory=$true)][string]$PlatformUrl,
  [Parameter(Mandatory=$true)][string]$EngineUrl,
  [Parameter(Mandatory=$true)][string]$LegacyUrl,
  [string]$OutputDirectory = "",
  [string]$Version = "",
  [string]$SharedNamespace = ""
)

$ErrorActionPreference = "Stop"
$taskPreparationArguments = @(
  (Join-Path $PSScriptRoot 'prepare-staging.js'),
  '--environment-id', $EnvId, '--platform-url', $PlatformUrl,
  '--engine-url', $EngineUrl, '--legacy-url', $LegacyUrl
)
if ($OutputDirectory) { $taskPreparationArguments += @('--output-directory', $OutputDirectory) }
if ($Version) { $taskPreparationArguments += @('--version', $Version) }
if ($SharedNamespace) { $taskPreparationArguments += @('--shared-namespace', $SharedNamespace) }
& node @taskPreparationArguments
if ($LASTEXITCODE -ne 0) { throw "隔离staging打包失败，未执行部署。" }
