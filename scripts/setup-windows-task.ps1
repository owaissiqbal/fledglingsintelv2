# Registers a Windows Task Scheduler entry that runs `pnpm ingest` every Monday at 06:00.
# Run once, in an elevated PowerShell:
#   pwsh ./scripts/setup-windows-task.ps1
# Re-running is safe — it removes any existing task with the same name first.
#
# To remove later:
#   Unregister-ScheduledTask -TaskName "Fledglings-Inspection-Refresh" -Confirm:$false

[CmdletBinding()]
param(
    [string]$TaskName = "Fledglings-Inspection-Refresh",
    [string]$RunAt = "06:00",
    [string]$DayOfWeek = "Monday",
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

Write-Host "Project root:  $ProjectRoot"
Write-Host "Task name:     $TaskName"
Write-Host "Schedule:      $DayOfWeek at $RunAt"

# Resolve pnpm. Prefer pnpm.cmd (npm shim) so the task runs without a shell.
$pnpmCmd = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)?.Source
if (-not $pnpmCmd) {
    $pnpmCmd = (Get-Command pnpm -ErrorAction SilentlyContinue)?.Source
}
if (-not $pnpmCmd) {
    Write-Error "pnpm not found on PATH. Install pnpm first: https://pnpm.io/installation"
    exit 1
}
Write-Host "pnpm found at: $pnpmCmd"

# Log file location
$logDir = Join-Path $ProjectRoot "data\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "scheduled-refresh.log"

# Wrap pnpm in cmd /c so output is appended to a log we can inspect.
$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$pnpmCmd ingest --refresh >> `"`"$logFile`"`" 2>&1`"" `
    -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $RunAt

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 30)

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing task $TaskName"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Weekly $DayOfWeek $RunAt refresh of the Fledglings inspection intelligence dashboard. Output appended to $logFile." | Out-Null

Write-Host ""
Write-Host "Task registered. Next run:" -ForegroundColor Green
Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo | Select-Object -Property NextRunTime, LastRunTime, LastTaskResult

Write-Host ""
Write-Host "Manual trigger:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "View log:        Get-Content '$logFile' -Tail 50"
Write-Host "Remove task:     Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
