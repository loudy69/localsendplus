<#
  Installs LocalSendPlus for the current user:
    - copies the app to %LOCALAPPDATA%\Programs\LocalSendPlus
    - creates Start Menu and Desktop shortcuts
    - adds a Windows Firewall rule for TCP/UDP 53317 (prompts for elevation)
  Usage:  powershell -ExecutionPolicy Bypass -File .\Install-LocalSendPlus.ps1 [-NoDesktopShortcut] [-NoFirewall] [-Port 53317]
#>
param([switch]$NoDesktopShortcut, [switch]$NoFirewall, [int]$Port = 53317)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA 'Programs\LocalSendPlus'
$exe = Join-Path $dest 'LocalSendPlus.exe'

Get-Process LocalSendPlus -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force -Exclude 'Install-LocalSendPlus.ps1'

$shell = New-Object -ComObject WScript.Shell
function New-Shortcut($path) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $dest
  $s.Description = 'LocalSendPlus - send files across LAN and VPN'
  $s.Save()
}
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LocalSendPlus.lnk'
New-Shortcut $startMenu
if (-not $NoDesktopShortcut) { New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'LocalSendPlus.lnk') }

if (-not $NoFirewall) {
  $rules = "netsh advfirewall firewall delete rule name='LocalSendPlus' | Out-Null; " +
           "netsh advfirewall firewall add rule name='LocalSendPlus' dir=in action=allow protocol=TCP localport=$Port profile=any | Out-Null; " +
           "netsh advfirewall firewall add rule name='LocalSendPlus' dir=in action=allow protocol=UDP localport=$Port profile=any | Out-Null"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($rules))
  try {
    Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile', '-EncodedCommand', $enc
    Write-Host "Firewall rule added for TCP/UDP $Port."
  } catch {
    Write-Warning 'Firewall rule was not added (elevation declined). You can add it later from Settings > Network.'
  }
}

Write-Host "LocalSendPlus installed to $dest"
Start-Process $exe
