// Системные уведомления от имени «Project Desktop», а не «Windows PowerShell».
//
// tauri-plugin-notification на Windows подставляет AppUserModelID только
// когда exe лежит НЕ в target/debug|release, и берёт для этого identifier
// из tauri.conf.json — а Windows показывает тост, только если этот AUMID
// знаком ей по ярлыку в меню «Пуск». В итоге сборка из target/release
// шлёт тосты от имени PowerShell, а установленная — под ID, которого нет
// ни у одного ярлыка, и Windows их молча складывает в историю.
//
// Поэтому тост показываем сами, под AUMID процесса:
// - установлено через Velopack — он уже выставил процессу свой AUMID
//   (velopack.<packId>) и прописал его в свой ярлык, берём его;
// - запуск без установки — свой AUMID и свой ярлык в меню «Пуск» на
//   текущий exe (без ярлыка Windows тост не покажет).

#[cfg(windows)]
use std::sync::OnceLock;

#[cfg(windows)]
const FALLBACK_AUMID: &str = "com.project.desktop";
#[cfg(windows)]
static AUMID: OnceLock<String> = OnceLock::new();

/// Вызывается один раз при запуске. Ошибки не роняют запуск — худшее,
/// что будет, — тосты без нашего имени.
#[cfg(windows)]
pub fn register() {
    use windows::Win32::UI::Shell::{GetCurrentProcessExplicitAppUserModelID, SetCurrentProcessExplicitAppUserModelID};

    let velopack = unsafe { GetCurrentProcessExplicitAppUserModelID() }.ok().and_then(|p| {
        let s = unsafe { p.to_string() }.ok();
        unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as _)) };
        s.filter(|s| !s.is_empty())
    });
    if let Some(id) = velopack {
        let _ = AUMID.set(id);
        return;
    }
    let _ = AUMID.set(FALLBACK_AUMID.to_string());
    // Окно на панели задач группируется с ярлыком по тому же AUMID.
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(&windows::core::HSTRING::from(FALLBACK_AUMID)) };
    if let Err(e) = ensure_shortcut() {
        log::warn!("Не удалось создать ярлык для уведомлений: {e}");
    }
}

/// «Пуск»\Программы\Project Desktop.lnk → текущий exe, с нашим AUMID.
#[cfg(windows)]
fn ensure_shortcut() -> windows::core::Result<()> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantChangeType, PROPVARIANT, PROPVAR_CHANGE_FLAGS};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let exe = std::env::current_exe().map_err(|_| windows::core::Error::from_win32())?;
    let Some(appdata) = std::env::var_os("APPDATA") else { return Ok(()) };
    let lnk = std::path::Path::new(&appdata).join(r"Microsoft\Windows\Start Menu\Programs\Project Desktop.lnk");

    unsafe {
        // S_FALSE/RPC_E_CHANGED_MODE — COM уже поднят в этом потоке, нам подходит.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(exe.as_os_str()))?;
        if let Some(dir) = exe.parent() {
            link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
        }
        link.SetDescription(&HSTRING::from("Project Desktop"))?;
        let store: IPropertyStore = link.cast()?;
        let bstr = PROPVARIANT::from(FALLBACK_AUMID);
        let mut value = PROPVARIANT::default();
        PropVariantChangeType(&mut value, &bstr, PROPVAR_CHANGE_FLAGS(0), VT_LPWSTR)?;
        store.SetValue(&PKEY_AppUserModel_ID, &value)?;
        store.Commit()?;
        link.cast::<IPersistFile>()?.Save(&HSTRING::from(lnk.as_os_str()), true)?;
    }
    Ok(())
}

/// Показать уведомление. На Windows — тост под AUMID процесса (см. выше),
/// на других ОС — обычным путём через плагин.
#[tauri::command]
pub fn notify_desktop(app: tauri::AppHandle, title: String, body: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = &app;
        use tauri_winrt_notification::Toast;
        let aumid = AUMID.get().cloned().unwrap_or_else(|| FALLBACK_AUMID.to_string());
        let body = body.unwrap_or_default();
        // show() ходит в WinRT — не в потоке IPC-обработчика.
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = Toast::new(&aumid).title(&title).text1(&body).show() {
                log::warn!("Уведомление не показано: {e}");
            }
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let mut n = app.notification().builder().title(title);
        if let Some(body) = body {
            n = n.body(body);
        }
        n.show().map_err(|e| e.to_string())
    }
}
