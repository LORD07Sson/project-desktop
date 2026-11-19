
use keyring::Entry;

const SERVICE: &str = "ProjectDesktop";
const USER: &str = "session";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, USER).map_err(|e| e.to_string())
}

pub fn save(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| e.to_string())
}

pub fn load() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "нужно реальное хранилище учётных данных ОС — недоступно на headless CI"]
    fn save_load_clear_roundtrip() {
        let token = "dsk_test_roundtrip_token";
        save(token).expect("save должен пройти при живом хранилище");
        assert_eq!(load().as_deref(), Some(token));
        clear().expect("clear должен пройти");
        assert_eq!(load(), None);
    }

    #[test]
    #[ignore = "нужно реальное хранилище учётных данных ОС — недоступно на headless CI"]
    fn clear_on_missing_entry_is_not_an_error() {
        clear().expect("clear() без сохранённого токена не должен быть ошибкой");
        clear().expect("повторный clear() тоже не должен быть ошибкой");
    }
}
