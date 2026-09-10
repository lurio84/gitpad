//! Tests de parseo que no dependen de un repo real. El foco está en el
//! formato `--porcelain=v2 -z`, donde los registros de renombrado (`2`)
//! llevan la ruta original en un token NUL extra: un `split('\0')` ingenuo
//! se desincroniza y corrompe el resto de la lista en silencio.

use super::repo::parse_status_tokens_for_test as parse;

#[test]
fn status_ordinario_staged_y_unstaged() {
    let tokens = vec![
        "# branch.head master".to_string(),
        "1 M. N... 100644 100644 100644 aaa bbb src/main.rs".to_string(),
        "1 .M N... 100644 100644 100644 ccc ddd README.md".to_string(),
    ];
    let s = parse(tokens).unwrap();
    assert_eq!(s.branch.as_deref(), Some("master"));
    assert_eq!(s.entries.len(), 2);
    assert_eq!(s.entries[0].path, "src/main.rs");
    assert_eq!(s.entries[0].staged, "M");
    assert_eq!(s.entries[0].unstaged, ".");
    assert_eq!(s.entries[1].path, "README.md");
    assert_eq!(s.entries[1].unstaged, "M");
}

#[test]
fn status_renombrado_consume_token_extra() {
    let tokens = vec![
        "# branch.head master".to_string(),
        "2 R. N... 100644 100644 100644 aaa bbb R100 nuevo.txt".to_string(),
        "viejo.txt".to_string(),
        "? sin-seguir.log".to_string(),
    ];
    let s = parse(tokens).unwrap();
    assert_eq!(s.entries.len(), 2, "el token 'viejo.txt' no debe contar como entrada");
    assert_eq!(s.entries[0].kind, "renamed");
    assert_eq!(s.entries[0].path, "nuevo.txt");
    assert_eq!(s.entries[0].orig_path.as_deref(), Some("viejo.txt"));
    assert_eq!(s.entries[1].path, "sin-seguir.log");
    assert_eq!(s.entries[1].kind, "untracked");
}

#[test]
fn status_renombrado_sin_token_original_es_error() {
    let tokens = vec![
        "# branch.head master".to_string(),
        "2 R. N... 100644 100644 100644 aaa bbb R100 nuevo.txt".to_string(),
        // falta el token con la ruta original
    ];
    assert!(parse(tokens).is_err(), "un registro `2` sin ruta original debe fallar");
}

#[test]
fn status_unmerged_con_ruta_con_espacios() {
    let tokens = vec![
        "# branch.head master".to_string(),
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc mi carpeta/archivo con espacios.txt"
            .to_string(),
    ];
    let s = parse(tokens).unwrap();
    assert_eq!(s.entries.len(), 1);
    assert_eq!(s.entries[0].kind, "unmerged");
    assert_eq!(s.entries[0].path, "mi carpeta/archivo con espacios.txt");
    assert_eq!(s.entries[0].staged, "U");
    assert_eq!(s.entries[0].unstaged, "U");
}

#[test]
fn status_branch_ab() {
    let tokens = vec![
        "# branch.head main".to_string(),
        "# branch.upstream origin/main".to_string(),
        "# branch.ab +3 -2".to_string(),
    ];
    let s = parse(tokens).unwrap();
    assert_eq!(s.ahead, 3);
    assert_eq!(s.behind, 2);
    assert_eq!(s.upstream.as_deref(), Some("origin/main"));
}

/// Un repo recién iniciado (sin commits) debe abrirse y dar un log vacío,
/// no un error. Crea un repo temporal de verdad con `git init`.
#[test]
fn repo_sin_commits_da_log_vacio() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let _guard = scopeguard(&dir);

    let ok = Command::new("git")
        .args(["init", "-q", "-b", "master"])
        .current_dir(&dir)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("git init no disponible, se salta el test");
        return;
    }

    let info = super::repo::open(&dir).expect("open de repo vacío");
    assert_eq!(info.head.as_deref(), Some("master"));

    let log = super::repo::log(&dir, 0, 50).expect("log de repo vacío");
    assert!(log.is_empty(), "un repo sin commits debe dar log vacío");

    let st = super::repo::status(&dir).expect("status de repo vacío");
    assert!(st.entries.is_empty());
}

/// `file_diff` debe devolver el diff del archivo pasando la ruta exacta tras
/// `--`, incluso si empieza por `-` o lleva espacios (el caso que rompería si
/// git leyera el nombre como opción).
#[test]
fn file_diff_rutas_raras_round_trip() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-diff-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let _guard = scopeguard(&dir);

    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(&dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if !git(&["init", "-q", "-b", "master"]) {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);

    for name in ["-raro.txt", "con espacio.txt"] {
        std::fs::write(dir.join(name), "uno\ndos\n").unwrap();
    }
    assert!(git(&["add", "-A"]));
    assert!(git(&["commit", "-q", "-m", "init"]));

    for name in ["-raro.txt", "con espacio.txt"] {
        std::fs::write(dir.join(name), "uno\nDOS\n").unwrap();
        let d = super::repo::file_diff(&dir, name, false).expect("file_diff");
        assert!(d.contains("-dos"), "diff de {name} sin la línea borrada:\n{d}");
        assert!(d.contains("+DOS"), "diff de {name} sin la línea añadida:\n{d}");
    }
}

/// `commit_diff` devuelve el diff del commit contra su padre, sin la cabecera
/// del mensaje. Un hash no hexadecimal es error (no se pasa a git).
#[test]
fn commit_diff_contra_el_padre() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-cdiff-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let _guard = scopeguard(&dir);

    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(&dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if !git(&["init", "-q", "-b", "master"]) {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join("f.txt"), "uno\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "primero"]);
    std::fs::write(dir.join("f.txt"), "uno\ndos\n").unwrap();
    git(&["commit", "-qam", "segundo"]);

    let head = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&dir)
        .output()
        .unwrap();
    let hash = String::from_utf8_lossy(&head.stdout).trim().to_string();

    let d = super::repo::commit_diff(&dir, &hash).expect("commit_diff");
    assert!(d.contains("+dos"), "falta la línea añadida:\n{d}");
    assert!(!d.contains("segundo"), "no debe incluir el mensaje del commit");

    assert!(super::repo::commit_diff(&dir, "no-hex").is_err());
}

/// Limpieza best-effort del directorio temporal al salir del test.
fn scopeguard(dir: &std::path::Path) -> impl Drop + '_ {
    struct G<'a>(&'a std::path::Path);
    impl Drop for G<'_> {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0);
        }
    }
    G(dir)
}

/// Smoke test contra un repo real. Ejecutar con:
///   GITPAD_SMOKE_REPO="C:\ruta\al\repo" cargo test smoke_repo_real -- --ignored --nocapture
#[test]
#[ignore = "requiere GITPAD_SMOKE_REPO apuntando a un repo Git real"]
fn smoke_repo_real() {
    use std::path::Path;
    let repo = std::env::var("GITPAD_SMOKE_REPO").expect("define GITPAD_SMOKE_REPO");
    let info = super::repo::open(Path::new(&repo)).expect("open");
    let root = Path::new(&info.root);

    let log = super::repo::log(root, 0, 10).expect("log");
    assert!(!log.is_empty(), "el repo debería tener commits");
    assert_eq!(log[0].hash.len(), 40, "hash completo esperado");

    let st = super::repo::status(root).expect("status");

    eprintln!("--- gitpad smoke ---");
    eprintln!("root      : {}", info.root);
    eprintln!("rama      : {:?}  (ahead {} / behind {})", st.branch, st.ahead, st.behind);
    eprintln!("upstream  : {:?}", st.upstream);
    eprintln!("HEAD      : {} {}", log[0].short_hash, log[0].subject);
    for c in log.iter().take(5) {
        eprintln!("  {} {:>12}  {}", c.short_hash, c.author_name, c.subject);
    }
    eprintln!("cambios   : {} entradas", st.entries.len());
    for e in &st.entries {
        eprintln!("  [{}{}] {} {}", e.staged, e.unstaged, e.kind, e.path);
    }
}

#[test]
fn refs_se_limpian_los_prefijos() {
    use super::repo::parse_refs_for_test as parse_refs;
    let r = parse_refs("HEAD -> master, origin/master, tag: v1.0");
    assert_eq!(r, vec!["master", "origin/master", "v1.0"]);
}
