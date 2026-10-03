# Разработка

Эндпоинты сервера — в [API.md](API.md).

## Стек

- **Tauri v2** (Rust) + **Vite**. Вкладки на vanilla JS, `Overview.jsx` —
  на [SolidJS](https://solidjs.com).
- **Автообновление** — [Velopack](https://velopack.io) через GitHub
  Releases, каналы stable и alpha.

## Разработка

Нужны Rust 1.88+, Node.js 24.15+ и
[системные зависимости Tauri](https://tauri.app/start/prerequisites/).

Сборка идёт через `cargo`, без `cargo-tauri` CLI. Поэтому без запущенного
`npm run dev` всегда добавляйте `--features custom-protocol`, иначе
приложение откроет `http://localhost:1420` и упадёт.

С hot-reload (два терминала):

```bash
npm install && npm run dev
```

```bash
cd src-tauri && cargo run
```

Без dev-сервера:

```bash
npm install && npm run build
cargo run --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

Релизный бинарник (без установщика):

```bash
npm run build
cargo build --release --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

Проверки (их же гоняет CI на каждом PR):

```bash
npm run lint
npm run build && npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

`npm test` проверяет собранный бандл: импорт модулей, жесты доски,
вкладку «Я» с пакетным QC, заметки с тайм-кодами.

`src-tauri/src/mpv_embed.rs` компилируется только под Windows. На другой
ОС его можно проверить так (тесты при этом не запускаются):

```bash
rustup target add x86_64-pc-windows-gnu
cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --all-targets
```

## Безопасность

- **Файлы.** Путь из вебвью бэкенд не принимает на веру: диалоги выбора
  открывает Rust и запоминает выбранное
  ([`file_scope.rs`](../src-tauri/src/file_scope.rs)). Новая команда, которая
  читает или пишет файл, должна проверять путь через `check_read` /
  `check_write` / `check_write_dir`.
- **Консоль разработчика** в релизе выключена: из неё можно вызвать любую
  команду с правами пользователя. Локально — `cargo run --features devtools`.
  Для диагностики есть логи: «Настройки» → «Открыть логи».

## Релизы

Версия задаётся в файле `VERSION`; CI подставляет её в `tauri.conf.json` и
`Cargo.toml`, Vite — в интерфейс.

Установщики (`Setup.exe`, `Portable.zip`, `.nupkg`) собирает только CI на
Windows через `vpk`:

- **stable** — [`build.yml`](../.github/workflows/build.yml): пуш в `main`
  с изменённым `VERSION`, релиз `v<VERSION>`.
- **alpha** — [`build-alpha.yml`](../.github/workflows/build-alpha.yml):
  каждый пуш в `main`, версия `<VERSION>-alpha.<запуск>+<коммит>`.

Канал выбирается в настройках приложения. Чтобы выпустить stable,
поднимите `VERSION` и влейте в `main`.

## Структура

| Путь | Что там |
|---|---|
| `src/` | Фронтенд: `index.html`, `styles.css`, модули в `src/app/` |
| `src-tauri/` | Rust: команды, трей, автообновление, QC звука, ffmpeg, mpv |
| `src-tauri/src/file_scope.rs` | Какие файлы вебвью вправе читать и перезаписывать |
| `src-tauri/src/media_tools.rs` | Операции ffmpeg |
| `src-tauri/src/board.rs` | Раскладка доски (покрыта тестами) |
| `src-tauri/binaries/` | `ffmpeg.exe`, `ffprobe.exe`, `mpv.exe` для Windows-сборки |
| `scripts/` | Тесты на собранном бандле (`npm test`) |
| `docs/API.md` | Эндпоинты сервера |
| `.github/workflows/` | CI: проверки PR, stable/alpha-сборки, CodeQL |
| `VERSION` | Номер версии |
