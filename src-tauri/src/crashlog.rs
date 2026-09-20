//! Rastro de un cierre inesperado.
//!
//! El perfil release usa `panic = "abort"` y `strip = true`: si un `panic!`
//! (o el `expect` final de `run()`) tumba la app en casa de otra persona, no
//! queda ni mensaje ni ubicación. Un hook de `std` se ejecuta *antes* del
//! abort, así que basta con apendar el mensaje a un archivo. No hace falta
//! `tauri-plugin-log`: nada más de la app loguea, y el hook sería necesario
//! igualmente (el plugin no engancha los panics).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

const FILE: &str = "gitpad.log";

/// Carpeta de datos de la app: la misma donde WebView2 guarda su perfil
/// (`%LOCALAPPDATA%\com.lurio84.gitpad`). `None` si no hay `LOCALAPPDATA`.
pub fn default_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("com.lurio84.gitpad"))
}

fn append(dir: &Path, line: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(FILE))?
        .write_all(line.as_bytes())
}

/// Instala el hook. Encadena el anterior para que en desarrollo el panic siga
/// saliendo también por stderr. Todo error de escritura se ignora: un fallo al
/// loguear no debe convertir un panic en otro.
pub fn install(dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let line = format!(
            "[unix {secs}] gitpad {} — {info}\n",
            env!("CARGO_PKG_VERSION")
        );
        let _ = append(&dir, &line);
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un panic real deja versión, ubicación y mensaje en el archivo.
    #[test]
    fn el_panic_queda_registrado() {
        let dir = std::env::temp_dir().join(format!(
            "gitpad-crashlog-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        // El hook es global al proceso: se restaura el anterior al terminar.
        let anterior = std::panic::take_hook();
        install(dir.clone());
        let r = std::panic::catch_unwind(|| panic!("fallo de prueba 42"));
        let _ = std::panic::take_hook();
        std::panic::set_hook(anterior);
        assert!(r.is_err());

        let texto = std::fs::read_to_string(dir.join(FILE)).expect("gitpad.log existe");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(texto.contains("fallo de prueba 42"), "mensaje: {texto}");
        assert!(texto.contains("crashlog.rs"), "ubicación: {texto}");
        assert!(texto.contains(env!("CARGO_PKG_VERSION")), "versión: {texto}");
    }
}
