param(
  [string]$Exe = "E:\DLD\Des_client\beta\Project Desktop.exe",
  [int]$Port = 9222
)

if (-not (Test-Path $Exe)) { Write-Error "Не найден $Exe — укажите путь параметром -Exe"; exit 1 }

$running = Get-Process -Name "project-desktop" -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Project Desktop уже запущен. Закрываю его (через трей: «Выход»), затем запустите скрипт снова." -ForegroundColor Yellow
  exit 2
}

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-allow-origins=*"
Start-Process -FilePath $Exe
Write-Host "Запущено с отладочным портом 127.0.0.1:$Port. Проверка: http://127.0.0.1:$Port/json"
