# ==========================================================
#  LiqhtLogger - tek tikla kurulum
#  Git, Node.js ve pnpm yoksa kurar, Vencord'u kaynaktan derler,
#  LiqhtLogger'i ekler ve Discord'a yukler.
#  Tekrar calistirilirsa her seyi gunceller.
# ==========================================================

$ErrorActionPreference = "Stop"

$PluginRepo  = "https://github.com/lqht81/liqhtlogger"
$VencordRepo = "https://github.com/Vendicated/Vencord"
$Base        = Join-Path $env:USERPROFILE "Vencord"
$PluginDir   = Join-Path $Base "src\userplugins\LiqhtLogger"

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "HATA: $text" -ForegroundColor Red; exit 1 }
function Has($cmd)   { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}

function Run($exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { Fail "$exe $($arguments -join ' ') basarisiz oldu (kod $LASTEXITCODE)" }
}

function Install-WithWinget($id, $name) {
    if (-not (Has "winget")) {
        Fail "$name kurulu degil ve winget bulunamadi. $name'i elle kurup bu dosyayi tekrar calistir."
    }
    Step "$name kuruluyor..."
    winget install --id $id -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
}

Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "        LiqhtLogger kurulumu"               -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta

# 1) Gerekli programlar
Refresh-Path
if (-not (Has "git"))  { Install-WithWinget "Git.Git" "Git" }
if (-not (Has "node")) { Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js" }
if (-not (Has "git"))  { Fail "Git kuruldu ama bulunamadi. Bilgisayari yeniden baslatip tekrar dene." }
if (-not (Has "node")) { Fail "Node.js kuruldu ama bulunamadi. Bilgisayari yeniden baslatip tekrar dene." }

if (-not (Has "pnpm.cmd")) {
    Step "pnpm kuruluyor..."
    Run "npm.cmd" @("i", "-g", "pnpm")
    Refresh-Path
    if (-not (Has "pnpm.cmd")) { Fail "pnpm kuruldu ama bulunamadi. PowerShell'i kapatip tekrar dene." }
}

# 2) Vencord
if (Test-Path (Join-Path $Base ".git")) {
    Step "Vencord guncelleniyor..."
    Run "git" @("-C", $Base, "pull")
} else {
    if (Test-Path $Base) { Fail "$Base klasoru var ama bir Vencord kaynak klasoru degil. Klasoru silip/tasiyip tekrar dene." }
    Step "Vencord indiriliyor..."
    Run "git" @("clone", $VencordRepo, $Base)
}

# 3) LiqhtLogger
if (Test-Path (Join-Path $PluginDir ".git")) {
    Step "LiqhtLogger guncelleniyor..."
    Run "git" @("-C", $PluginDir, "pull")
} else {
    Step "LiqhtLogger indiriliyor..."
    New-Item -ItemType Directory -Force (Split-Path $PluginDir) | Out-Null
    Run "git" @("clone", $PluginRepo, $PluginDir)
}

# 4) Derleme
Set-Location $Base
Step "Bagimliliklar kuruluyor (ilk seferde birkac dakika surebilir)..."
Run "pnpm.cmd" @("install", "--frozen-lockfile")
Step "Derleniyor..."
Run "pnpm.cmd" @("build")

# 5) Masaustu kisayollari
$Desktop = [Environment]::GetFolderPath("Desktop")
Copy-Item (Join-Path $PluginDir "scripts\LiqhtLogger Guncelle.bat") $Desktop -Force
Copy-Item (Join-Path $PluginDir "scripts\Vencord Yeniden Yukle.bat") $Desktop -Force

# 6) Discord'a yukleme
Step "Discord'a yukleniyor"
Write-Host "Acilan menude ok tuslariyla kullandigin Discord'u sec ve Enter'a bas." -ForegroundColor Yellow
Write-Host "(Normal Discord = Stable)" -ForegroundColor Yellow
& pnpm.cmd inject

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " Bitti!" -ForegroundColor Green
Write-Host " 1. Discord'u sistem tepsisinden de kapatip (Quit) tekrar ac." -ForegroundColor Green
Write-Host " 2. Ayarlar > Vencord > Plugins > LiqhtLogger'i ac." -ForegroundColor Green
Write-Host " 3. Ilerde guncellemek icin masaustundeki 'LiqhtLogger Guncelle' dosyasini calistir." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
