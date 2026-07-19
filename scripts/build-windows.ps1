# Build Artefact Cataloguer for Windows arm64 and x86_64.
#
# Prerequisites:
#   - Node >= 26
#   - Rust toolchain (rustup) with both targets installed:
#       rustup target add aarch64-pc-windows-msvc x86_64-pc-windows-msvc
#   - Windows SDK (for the MSVC linker).
#   - protoc (the build auto-downloads the x64 binary to %LOCALAPPDATA%\protoc
#     if not on PATH; on arm64 machines it runs under Windows 11 x64 emulation).
#
# Output:
#   src-tauri/target/<triple>/release/bundle/nsis/

param(
    [switch]$Arm64,
    [switch]$X64
)

$ErrorActionPreference = "Stop"

# Default: build both targets.
if (-not $Arm64 -and -not $X64) { $Arm64 = $true; $X64 = $true }

Write-Host "==> Installing dependencies" -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

function Ensure-Target($triple) {
    $installed = (rustup target list --installed) -join "`n"
    if ($installed -notmatch [regex]::Escape($triple)) {
        Write-Host "==> Adding Rust target $triple" -ForegroundColor Yellow
        rustup target add $triple | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "rustup target add $triple failed" }
    }
}

# lance's prost-build shells out to protoc at compile time. Download the x64
# binary on demand (arm64 runs it under Windows 11's default x64 emulation).
function Ensure-Protoc {
    $existing = Get-Command protoc.exe -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "==> protoc already on PATH ($($existing.Source))" -ForegroundColor DarkGray
        return
    }
    $installDir = Join-Path $env:LOCALAPPDATA "protoc"
    $bin = Join-Path $installDir "bin\protoc.exe"
    if (-not (Test-Path $bin)) {
        $version = "30.2"
        $url = "https://github.com/protocolbuffers/protobuf/releases/download/v$version/protoc-$version-win64.zip"
        Write-Host "==> Downloading protoc $version (x64; emulated on arm64)" -ForegroundColor Yellow
        $zip = Join-Path $env:TEMP "protoc-$version.zip"
        Invoke-WebRequest -Uri $url -OutFile $zip
        Expand-Archive -Path $zip -DestinationPath $installDir -Force
        Remove-Item $zip
    }
    $env:PATH = "$installDir\bin;$env:PATH"
    $env:PROTOC = $bin
    & $bin --version | Out-Host
}

Ensure-Protoc

function Build($triple, $label) {
    Write-Host "==> Building $label ($triple)" -ForegroundColor Cyan
    npx tauri build --target $triple
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed for $triple" }
    Write-Host "==> Done: $label" -ForegroundColor Green
    Write-Host "    src-tauri/target/$triple/release/bundle/" -ForegroundColor DarkGray
}

if ($Arm64) {
    Ensure-Target "aarch64-pc-windows-msvc"
    Build "aarch64-pc-windows-msvc" "Windows ARM64"
}
if ($X64) {
    Ensure-Target "x86_64-pc-windows-msvc"
    Build "x86_64-pc-windows-msvc" "Windows x86_64"
}

Write-Host "==> All builds complete." -ForegroundColor Green
