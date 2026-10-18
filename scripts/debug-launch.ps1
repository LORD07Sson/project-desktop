<#
  Запуск Project Desktop с отладочным портом WebView2 — чтобы ИИ-агент через MCP (tools/desktop-mcp)
  видел настоящее окно: скриншоты, список элементов, клики.
  Порт слушает только 127.0.0.1 и открыт, пока программа запущена этим скриптом.
  Обычный запуск программы порт НЕ открывает.

  Использование:  powershell -File scripts\debug-launch.ps1 [-Exe "путь\к\Project Desktop.exe"] [-Port 9222]
#>
param(
  [string]$Exe = "E:\DLD\Des_client\beta\Project Desktop.exe",
  [int]$Port = 9222
)

if (-not (Test-Path $Exe)) { Write-Error "Не найден $Exe — укажите путь параметром -Exe"; exit 1 }

# Программа в одном экземпляре: если она уже запущена, новый запуск просто покажет старое окно БЕЗ порта.
$running = Get-Process -Name "project-desktop" -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Project Desktop уже запущен. Закрываю его (через трей: «Выход»), затем запустите скрипт снова." -ForegroundColor Yellow
  exit 2
}

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-allow-origins=*"
Start-Process -FilePath $Exe
Write-Host "Запущено с отладочным портом 127.0.0.1:$Port. Проверка: http://127.0.0.1:$Port/json"
