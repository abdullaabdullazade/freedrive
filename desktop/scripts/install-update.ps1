# Install the freshly built NSIS bundle in update mode.
# /UPDATE skips Tauri's reinstall page, so the old version is never uninstalled:
# login, %APPDATA%\FreeDrive\sync.db, My Drive and the Explorer registration survive.

$ErrorActionPreference = "Stop"

$bundleDir = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\nsis"
if (-not (Test-Path $bundleDir)) {
    throw "No NSIS bundle directory at $bundleDir. Run: npm run build:exe"
}

$setup = Get-ChildItem -Path $bundleDir -Filter "FreeDrive_*_x64-setup.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $setup) {
    throw "No FreeDrive_*_x64-setup.exe in $bundleDir. Run: npm run build:exe"
}

Write-Host "Updating in place with $($setup.Name)"
$proc = Start-Process -FilePath $setup.FullName -ArgumentList "/UPDATE" -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    throw "Installer exited with code $($proc.ExitCode)"
}
Write-Host "Update finished - sign-in, sync.db and My Drive were preserved."
