# Canonical FreeDrive mobile APK build (Windows).
# Incremental by default: sync TS -> C:\fdm, gradlew, copy to mobile\dist.
param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$RepoMobile = Split-Path $PSScriptRoot -Parent
$Fdm = "C:\fdm"
$ApkSrc = Join-Path $Fdm "android\app\build\outputs\apk\release\app-release.apk"
$ApkDest = Join-Path $RepoMobile "dist\FreeDrive-1.0.0.apk"

if ($Clean -and (Test-Path $Fdm)) {
    Remove-Item -Recurse -Force $Fdm
}

if (-not (Test-Path $Fdm)) {
    New-Item -ItemType Directory -Path $Fdm -Force | Out-Null
}

robocopy $RepoMobile $Fdm /E /XD node_modules android .expo dist /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }

# Keep native Downloads module sources in sync without a full expo prebuild.
$NativeJava = Join-Path $Fdm "android\app\src\main\java\com\freedrive\mobile"
$PluginDir = Join-Path $RepoMobile "plugins\with-freedrive-downloads"
if (Test-Path $NativeJava) {
    foreach ($name in @("DownloadsModule.kt", "DownloadsPackage.kt")) {
        $src = Join-Path $PluginDir $name
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $NativeJava $name) -Force
        }
    }
}

# Streaming AES-GCM decrypt requires BouncyCastle (Conscrypt buffers entire AEAD).
$GradlePath = Join-Path $Fdm "android\app\build.gradle"
if (Test-Path $GradlePath) {
    $gradle = Get-Content $GradlePath -Raw
        if ($gradle -notmatch "bcprov-jdk18on") {
            $bcLine = '    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")'
            if ($gradle -match "dependencies\s*\{") {
                $gradle = $gradle -replace "dependencies\s*\{", "dependencies {`r`n$bcLine"
            } else {
                $gradle = $gradle + "`r`n`r`ndependencies {`r`n$bcLine`r`n}`r`n"
            }
            Set-Content -Path $GradlePath -Value $gradle -NoNewline
        }
}

# Keep Android versionCode in sync with app.json (prebuild only runs once).
$AppJsonPath = Join-Path $Fdm "app.json"
if ((Test-Path $AppJsonPath) -and (Test-Path $GradlePath)) {
    $appJson = Get-Content $AppJsonPath -Raw | ConvertFrom-Json
    $vc = $appJson.expo.android.versionCode
    if ($vc) {
        $gradle = Get-Content $GradlePath -Raw
        $updated = [regex]::Replace($gradle, 'versionCode\s+\d+', "versionCode $vc")
        if ($updated -ne $gradle) {
            Set-Content -Path $GradlePath -Value $updated -NoNewline
        }
    }
}

if (-not (Test-Path (Join-Path $Fdm "node_modules"))) {
    Push-Location $Fdm
    npm ci
    Pop-Location
}

if (-not (Test-Path (Join-Path $Fdm "android"))) {
    $env:CI = "1"
    Push-Location $Fdm
    npx expo prebuild --platform android
    Pop-Location
}

$env:CI = "1"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot"
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

Push-Location (Join-Path $Fdm "android")
.\gradlew.bat assembleRelease
Pop-Location

if (-not (Test-Path $ApkSrc)) {
    Write-Error "APK not found: $ApkSrc"
}

New-Item -ItemType Directory -Force -Path (Split-Path $ApkDest -Parent) | Out-Null
Copy-Item $ApkSrc $ApkDest -Force
Get-Item $ApkDest | Format-List FullName, Length, LastWriteTime
