$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '找不到 Node.js。請先安裝 Node.js LTS，再重新開啟 PowerShell。' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath 'dist/index.html')) {
    Write-Host '尚未建立網站成品。請先執行 npm.cmd install 以及 npm.cmd run build。' -ForegroundColor Yellow
    exit 1
}

Write-Host '本機預覽：http://localhost:3000。API Key 請直接在網頁輸入，不需要 .env。' -ForegroundColor Green
node scripts/serve.mjs
