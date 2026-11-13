param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bass-sdk.json') -Raw | ConvertFrom-Json
$cacheRoot = Join-Path $projectRoot '.cache\bass-sdk'
$sdkRoot = Join-Path $projectRoot 'android\bass-sdk'
New-Item -ItemType Directory -Path $cacheRoot, $sdkRoot -Force | Out-Null

foreach ($component in $manifest.components) {
    $archive = Join-Path $cacheRoot $component.archive
    if (!(Test-Path -LiteralPath $archive)) {
        if ($Offline) { throw "Missing SDK archive: $archive" }
        Invoke-WebRequest -Uri ($manifest.baseUrl + $component.archive) -OutFile $archive -UseBasicParsing
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $component.sha256) {
        throw "BASS SDK hash mismatch: $archive. Review the official release before updating bass-sdk.json."
    }
    $expanded = Join-Path $cacheRoot $component.name
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
    $javaSource = Join-Path $expanded 'java\com\un4seen\bass'
    $javaTarget = Join-Path $sdkRoot 'java\com\un4seen\bass'
    New-Item -ItemType Directory -Path $javaTarget -Force | Out-Null
    Get-ChildItem -LiteralPath $javaSource -Filter '*.java' | Copy-Item -Destination $javaTarget -Force
    foreach ($abi in $manifest.architectures) {
        $target = Join-Path $sdkRoot "jniLibs\$abi"
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $expanded "libs\$abi\lib$($component.name).so") -Destination $target -Force
    }
    $notices = Join-Path $sdkRoot 'licenses'
    New-Item -ItemType Directory -Path $notices -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $expanded "$($component.name).txt") -Destination $notices -Force
}
Write-Output 'BASS Android SDK verified and installed.'
