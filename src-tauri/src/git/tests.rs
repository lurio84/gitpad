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
    assert_eq!(info.head_hash, None, "sin commits, head_hash debe ser None");

    let log = super::repo::log(&dir, 0, 50, &super::repo::LogFilter::None, None).expect("log de repo vacío");
    assert!(log.is_empty(), "un repo sin commits debe dar log vacío");

    let st = super::repo::status(&dir).expect("status de repo vacío");
    assert!(st.entries.is_empty());
}

/// `head_hash` debe traer el hash completo de HEAD en un repo con commits, y
/// seguir apuntando al mismo commit tras cambiar a HEAD detached.
#[test]
fn open_da_head_hash() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-headhash-{}-{}",
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
    git(&["commit", "-q", "-m", "init"]);

    let head = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&dir)
        .output()
        .unwrap();
    let hash = String::from_utf8_lossy(&head.stdout).trim().to_string();

    let info = super::repo::open(&dir).expect("open");
    assert_eq!(info.head_hash.as_deref(), Some(hash.as_str()));

    git(&["checkout", "-q", "--detach", "HEAD"]);
    let info2 = super::repo::open(&dir).expect("open detached");
    assert_eq!(info2.head, None, "detached: head (nombre de rama) debe ser None");
    assert_eq!(
        info2.head_hash.as_deref(),
        Some(hash.as_str()),
        "detached: head_hash debe seguir apuntando al mismo commit"
    );
}

/// FEAT-002: `get_log` debe traer el cuerpo del mensaje (`%b`), no solo el
/// asunto — el panel del mensaje del commit distingue las dos partes.
#[test]
fn log_incluye_body_del_commit() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-logbody-{}-{}",
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
    git(&["commit", "-q", "-m", "asunto\n\nlinea 1 del cuerpo\nlinea 2 del cuerpo"]);

    std::fs::write(dir.join("f.txt"), "dos\n").unwrap();
    git(&["commit", "-qam", "sin cuerpo"]);

    let log = super::repo::log(&dir, 0, 10, &super::repo::LogFilter::None, None).expect("log");
    assert_eq!(log.len(), 2);
    // --date-order: el más reciente primero.
    assert_eq!(log[0].subject, "sin cuerpo");
    assert_eq!(log[0].body, "", "un commit sin cuerpo debe dar body vacío");
    assert_eq!(log[1].subject, "asunto");
    assert_eq!(
        log[1].body, "linea 1 del cuerpo\nlinea 2 del cuerpo",
        "el body no debe llevar el salto de línea final que añade git"
    );
}

/// `log` con `branch` muestra solo el historial de esa rama (sin `--all`), sirve
/// para remotas y rechaza refs sin el prefijo `refs/` (un nombre no debe poder
/// leerse como opción de git).
#[test]
fn log_de_una_rama() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-logbranch-{}-{}",
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

    std::fs::write(dir.join("f.txt"), "base
").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);
    git(&["checkout", "-qb", "otra"]);
    std::fs::write(dir.join("g.txt"), "solo otra
").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "solo en otra"]);
    git(&["checkout", "-q", "master"]);
    std::fs::write(dir.join("f.txt"), "master
").unwrap();
    git(&["commit", "-qam", "solo en master"]);

    let none = super::repo::LogFilter::None;
    let all = super::repo::log(&dir, 0, 10, &none, None).expect("log --all");
    assert_eq!(all.len(), 3, "sin rama se ven todas: {all:?}");

    let master = super::repo::log(&dir, 0, 10, &none, Some("refs/heads/master")).expect("log master");
    let subjects: Vec<&str> = master.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["solo en master", "base"], "master no debe traer commits de otra");

    let otra = super::repo::log(&dir, 0, 10, &none, Some("refs/heads/otra")).expect("log otra");
    let subjects: Vec<&str> = otra.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["solo en otra", "base"]);

    // Combina con la búsqueda: el filtro se aplica dentro de la rama.
    let q = super::repo::LogFilter::Message("solo".into());
    let hits = super::repo::log(&dir, 0, 10, &q, Some("refs/heads/otra")).expect("log otra + búsqueda");
    assert_eq!(hits.len(), 1);

    // Sin prefijo `refs/`: rechazada, nunca llega a git.
    assert!(super::repo::log(&dir, 0, 10, &none, Some("--all")).is_err());
    assert!(super::repo::log(&dir, 0, 10, &none, Some("master")).is_err());
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

/// `commit_files` cubre: commit normal, commit raíz, renombrado (3 registros
/// NUL), ruta no-ASCII y merge (lista y diff contra su primer padre).
#[test]
fn commit_files_casos() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-cfiles-{}-{}",
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
    let git_out = |args: &[&str]| {
        String::from_utf8_lossy(
            &Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string()
    };
    if !git(&["init", "-q", "-b", "master"]) {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);

    // Commit raíz: sin padre, diffea contra el árbol vacío.
    std::fs::write(dir.join("f.txt"), "uno\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "raiz"]);
    let root_hash = git_out(&["rev-parse", "HEAD"]);
    let root_files = super::repo::commit_files(&dir, &root_hash).expect("commit_files raiz");
    assert_eq!(root_files.len(), 1);
    assert_eq!(root_files[0].path, "f.txt");
    assert_eq!(root_files[0].status, "A");
    assert!(root_files[0].orig_path.is_none());

    // Commit normal: modifica f.txt.
    std::fs::write(dir.join("f.txt"), "uno\ndos\n").unwrap();
    git(&["commit", "-qam", "modifica"]);
    let mod_hash = git_out(&["rev-parse", "HEAD"]);
    let mod_files = super::repo::commit_files(&dir, &mod_hash).expect("commit_files modifica");
    assert_eq!(mod_files.len(), 1);
    assert_eq!(mod_files[0].path, "f.txt");
    assert_eq!(mod_files[0].status, "M");

    // Renombrado: 3 registros NUL (status, ruta vieja, ruta nueva).
    git(&["mv", "f.txt", "g.txt"]);
    git(&["commit", "-qam", "renombra"]);
    let ren_hash = git_out(&["rev-parse", "HEAD"]);
    let ren_files = super::repo::commit_files(&dir, &ren_hash).expect("commit_files renombra");
    assert_eq!(ren_files.len(), 1);
    assert_eq!(ren_files[0].path, "g.txt");
    assert_eq!(ren_files[0].orig_path.as_deref(), Some("f.txt"));
    assert!(ren_files[0].status.starts_with('R'), "status: {}", ren_files[0].status);

    // Ruta no-ASCII: con `-z` no debe salir octal-escapada ni corrompida.
    std::fs::write(dir.join("café.txt"), "leche\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "no-ascii"]);
    let na_hash = git_out(&["rev-parse", "HEAD"]);
    let na_files = super::repo::commit_files(&dir, &na_hash).expect("commit_files no-ascii");
    assert_eq!(na_files.len(), 1);
    assert_eq!(na_files[0].path, "café.txt");

    // Merge: dos ramas divergentes. Con `-m --first-parent` un merge enseña lo
    // que trajo la rama fusionada respecto a su primer padre; sin ello git daba
    // lista y diff vacíos y no había forma de revisar un merge.
    git(&["checkout", "-qb", "rama"]);
    std::fs::write(dir.join("rama.txt"), "rama\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "en rama"]);
    git(&["checkout", "-q", "master"]);
    std::fs::write(dir.join("master.txt"), "master\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "en master"]);
    git(&["merge", "-q", "--no-ff", "-m", "merge", "rama"]);
    let merge_hash = git_out(&["rev-parse", "HEAD"]);
    let merge_files = super::repo::commit_files(&dir, &merge_hash).expect("commit_files merge");
    assert_eq!(merge_files.len(), 1, "merge debe listar lo que trajo la rama: {merge_files:?}");
    assert_eq!(merge_files[0].path, "rama.txt");
    assert_eq!(merge_files[0].status, "A");
    let merge_diff = super::repo::commit_diff(&dir, &merge_hash).expect("commit_diff merge");
    assert!(merge_diff.contains("+rama"), "el diff del merge debe traer rama.txt: {merge_diff:?}");
    assert!(!merge_diff.contains("master.txt"), "lo del primer padre no cuenta como cambio del merge");
    let merge_file_diff = super::repo::commit_file_diff(&dir, &merge_hash, "rama.txt", None)
        .expect("commit_file_diff merge");
    assert!(merge_file_diff.contains("+rama"), "{merge_file_diff:?}");

    assert!(super::repo::commit_files(&dir, "no-hex").is_err());
}

/// `tree_files` lista TODO el árbol del commit, no solo lo que tocó: rutas
/// anidadas con su prefijo de directorio, nombres no-ASCII sin octal-escapar
/// y, por `-r` sin `-t`, ninguna entrada de directorio suelta.
#[test]
fn tree_files_lista_el_arbol_completo() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-tree-{}-{}",
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
    let git_out = |args: &[&str]| {
        String::from_utf8_lossy(
            &Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string()
    };
    if !git(&["init", "-q", "-b", "master"]) {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);

    std::fs::write(dir.join("raiz.txt"), "raiz\n").unwrap();
    std::fs::create_dir_all(dir.join("src/interno")).unwrap();
    std::fs::write(dir.join("src/uno.rs"), "uno\n").unwrap();
    std::fs::write(dir.join("src/interno/dos.rs"), "dos\n").unwrap();
    std::fs::create_dir_all(dir.join("ñandú")).unwrap();
    std::fs::write(dir.join("ñandú/ç.txt"), "aves\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "arbol"]);
    let hash = git_out(&["rev-parse", "HEAD"]);

    let mut files = super::repo::tree_files(&dir, &hash).expect("tree_files");
    files.sort();
    assert_eq!(
        files,
        vec![
            "raiz.txt".to_string(),
            "src/interno/dos.rs".to_string(),
            "src/uno.rs".to_string(),
            "ñandú/ç.txt".to_string(),
        ],
        "el árbol debe listar blobs con su ruta completa y sin escapar",
    );
    // `-r` sin `-t`: los directorios no son entradas propias.
    assert!(!files.iter().any(|f| f == "src" || f == "ñandú"));

    // Un commit anterior no ve lo que se añadió después.
    std::fs::write(dir.join("tarde.txt"), "tarde\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "mas tarde"]);
    let viejos = super::repo::tree_files(&dir, &hash).expect("tree_files viejo");
    assert!(!viejos.iter().any(|f| f == "tarde.txt"));

    assert!(matches!(
        super::repo::tree_files(&dir, "HEAD;rm"),
        Err(super::error::GitError::Parse(_))
    ));
}

/// `file_content` y sus dos guardas obligatorias (binario por NUL, tope de
/// tamaño con corte en un límite de carácter UTF-8), más la degradación lossy
/// para texto no-UTF-8 y los errores de ruta inexistente / hash inválido.
#[test]
fn file_content_casos() {
    use super::repo::MAX_FILE_BYTES;
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-fcontent-{}-{}",
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
    let git_out = |args: &[&str]| {
        String::from_utf8_lossy(
            &Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string()
    };
    if !git(&["init", "-q", "-b", "master"]) {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    // Sin esto, con autocrlf global activo git podría normalizar los saltos y
    // el texto exacto dejaría de serlo.
    git(&["config", "core.autocrlf", "false"]);

    // (b) texto llano.
    std::fs::write(dir.join("plano.txt"), "hola\nmundo\n").unwrap();
    // (c) binario: NUL dentro de los primeros 8000 bytes.
    std::fs::write(dir.join("bin.dat"), [0x89u8, 0x50, 0x00, 0x1a, 0x0a]).unwrap();
    // (e) texto latin-1: 0xE9 (é) suelto, sin ningún NUL.
    std::fs::write(dir.join("latin1.txt"), [b'h', b'o', b'l', 0xE9, b'\n']).unwrap();
    // (d) >2 MiB de caracteres multibyte. La "x" inicial descoloca el corte:
    // sin ella el tope cae justo en un límite de carácter (MAX es par y "é"
    // ocupa 2 bytes) y la guarda no se ejercitaría.
    let mut grande = String::from("x");
    grande.push_str(&"é".repeat(1_100_000));
    let grande_len = grande.len() as u64;
    assert!(grande_len > MAX_FILE_BYTES as u64);
    std::fs::write(dir.join("grande.txt"), &grande).unwrap();
    // (h) archivo que cambia entre dos commits.
    std::fs::write(dir.join("versionado.txt"), "v1\n").unwrap();

    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "primero"]);
    let hash1 = git_out(&["rev-parse", "HEAD"]);

    std::fs::write(dir.join("versionado.txt"), "v2\n").unwrap();
    git(&["commit", "-qam", "segundo"]);
    let hash2 = git_out(&["rev-parse", "HEAD"]);

    // (b) texto exacto.
    let plano = super::repo::file_content(&dir, &hash1, "plano.txt").expect("plano");
    assert_eq!(plano.text.as_deref(), Some("hola\nmundo\n"));
    assert!(!plano.binary);
    assert!(!plano.truncated);
    assert_eq!(plano.bytes, 11);

    // (c) binario.
    let bin = super::repo::file_content(&dir, &hash1, "bin.dat").expect("bin");
    assert!(bin.binary, "un NUL en los primeros 8000 bytes es binario");
    assert!(bin.text.is_none());
    assert!(!bin.truncated);
    assert_eq!(bin.bytes, 5);

    // (d) recorte en un límite de carácter válido.
    let big = super::repo::file_content(&dir, &hash1, "grande.txt").expect("grande");
    assert!(big.truncated, "más de 2 MiB debe recortarse");
    assert_eq!(big.bytes, grande_len, "bytes siempre es el tamaño real");
    assert!(!big.binary);
    let texto = big.text.expect("texto recortado");
    assert!(
        texto.len() <= MAX_FILE_BYTES,
        "el texto recortado mide {} bytes",
        texto.len()
    );
    assert_eq!(
        texto.len(),
        MAX_FILE_BYTES - 1,
        "debe retroceder exactamente el byte suelto del carácter partido"
    );
    assert!(texto.ends_with('é'), "no debe acabar a mitad de carácter");
    assert!(
        !texto.contains('\u{FFFD}'),
        "el corte no debe meter caracteres de reemplazo"
    );

    // (e) no-UTF-8 sin NULs: texto degradado, no error ni binario.
    let latin = super::repo::file_content(&dir, &hash1, "latin1.txt").expect("latin1");
    assert!(!latin.binary, "sin NULs no es binario aunque no sea UTF-8");
    let lt = latin.text.expect("texto lossy");
    assert!(lt.starts_with("hol"), "texto: {lt:?}");
    assert_eq!(latin.bytes, 5);
    assert!(!latin.truncated);

    // (h) el commit viejo devuelve el contenido viejo.
    let v1 = super::repo::file_content(&dir, &hash1, "versionado.txt").expect("v1");
    assert_eq!(v1.text.as_deref(), Some("v1\n"));
    let v2 = super::repo::file_content(&dir, &hash2, "versionado.txt").expect("v2");
    assert_eq!(v2.text.as_deref(), Some("v2\n"));

    // (f) ruta inexistente: el fallo de git sale tal cual.
    assert!(matches!(
        super::repo::file_content(&dir, &hash1, "no-existe.txt"),
        Err(super::error::GitError::CommandFailed { .. })
    ));

    // (g) hash no hexadecimal: ni se llega a invocar git.
    assert!(matches!(
        super::repo::file_content(&dir, "HEAD;rm", "plano.txt"),
        Err(super::error::GitError::Parse(_))
    ));
    // Ruta vacía o con NUL tampoco llega a git.
    assert!(matches!(
        super::repo::file_content(&dir, &hash1, ""),
        Err(super::error::GitError::Parse(_))
    ));
}

/// `commit_file_diff` para un archivo renombrado necesita la ruta vieja
/// (`orig_path`) además de la nueva: un pathspec restringido solo a la ruta
/// nueva no empareja con la vieja y git enseña un archivo nuevo en vez de un
/// renombrado. Cubre también el viaje de ida y vuelta de una ruta no-ASCII
/// (con `-c core.quotePath=false` no debe salir octal-escapada).
#[test]
fn commit_file_diff_renombrado_necesita_ruta_original() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-cfdiff-ren-{}-{}",
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
    let git_out = |args: &[&str]| {
        String::from_utf8_lossy(
            &Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string()
    };
    if !git(&["init", "-q", "-b", "master"]) {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);

    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "b"]);
    git(&["mv", "b.txt", "café.txt"]);
    git(&["commit", "-q", "-m", "renombra"]);
    let hash = git_out(&["rev-parse", "HEAD"]);

    // Sin orig_path: pathspec restringido a la ruta nueva no empareja con la
    // vieja, git no ve el rename y muestra un archivo nuevo — el bug real.
    let broken = super::repo::commit_file_diff(&dir, &hash, "café.txt", None)
        .expect("commit_file_diff sin orig_path");
    assert!(
        broken.contains("new file mode"),
        "se esperaba reproducir el bug (archivo nuevo, no rename):\n{broken}"
    );

    // Con orig_path: git empareja el rename.
    let fixed = super::repo::commit_file_diff(&dir, &hash, "café.txt", Some("b.txt"))
        .expect("commit_file_diff con orig_path");
    assert!(fixed.contains("rename from b.txt"), "diff:\n{fixed}");
    assert!(fixed.contains("rename to café.txt"), "diff:\n{fixed}");
    assert!(
        !fixed.contains("\\303\\251"),
        "la ruta no debe salir octal-escapada:\n{fixed}"
    );
}

/// stage → commit → unstage a través de la capa, con rutas raras. Comprueba
/// contra `git status` real que el índice quedó como se espera.
#[test]
fn stage_commit_unstage_round_trip() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-stage-{}-{}",
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
            .output()
            .map(|o| (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned()))
            .unwrap_or((false, String::new()))
    };
    if !git(&["init", "-q", "-b", "master"]).0 {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);

    let names = ["-raro.txt", "con espacio.txt", "normal.txt"];
    for n in names {
        std::fs::write(dir.join(n), "x\n").unwrap();
    }

    // Sin nada preparado, commit debe fallar con mensaje, no con panic.
    assert!(super::repo::commit(&dir, "vacío", false).is_err());

    let paths: Vec<String> = names.iter().map(|s| s.to_string()).collect();
    super::repo::stage(&dir, &paths).expect("stage");
    let (_, staged) = git(&["diff", "--cached", "--name-only", "-z"]);
    for n in names {
        assert!(staged.contains(n), "{n} no quedó preparado; índice: {staged:?}");
    }

    // Mensaje que empieza por `-`: por stdin no se lee como opción de git.
    super::repo::commit(&dir, "-arreglo raro", false).expect("commit");
    let (_, subject) = git(&["log", "-1", "--pretty=%s"]);
    assert_eq!(subject.trim(), "-arreglo raro");

    // Nuevo cambio, preparar y sacar del índice.
    std::fs::write(dir.join("normal.txt"), "y\n").unwrap();
    super::repo::stage(&dir, &["normal.txt".to_string()]).expect("stage 2");
    super::repo::unstage(&dir, &["normal.txt".to_string()]).expect("unstage");
    let (_, cached) = git(&["diff", "--cached", "--name-only"]);
    assert!(cached.trim().is_empty(), "el índice debería estar vacío: {cached:?}");
}

/// `discard`: un archivo seguido vuelve exactamente al contenido de HEAD
/// (tanto si estaba staged como si no); uno sin seguir se borra del disco.
#[test]
fn discard_seguido_y_sin_seguir() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-discard-{}-{}",
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
    std::fs::write(dir.join("f.txt"), "original\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "init"]);

    // Modificado sin stage: discard debe devolver el contenido de HEAD.
    // `core.autocrlf` de Windows puede convertir el salto de línea al
    // extraer del índice, así que se normaliza antes de comparar (no es lo
    // que este test cubre).
    std::fs::write(dir.join("f.txt"), "modificado\n").unwrap();
    super::repo::discard(&dir, &["f.txt".to_string()], &[], false).expect("discard unstaged");
    assert_eq!(
        std::fs::read_to_string(dir.join("f.txt")).unwrap().replace("\r\n", "\n"),
        "original\n",
        "discard debe devolver el archivo al contenido de HEAD"
    );

    // Modificado Y staged: discard debe limpiar índice y árbol de trabajo a la vez.
    std::fs::write(dir.join("f.txt"), "modificado 2\n").unwrap();
    super::repo::stage(&dir, &["f.txt".to_string()]).expect("stage");
    super::repo::discard(&dir, &["f.txt".to_string()], &[], false).expect("discard staged");
    assert_eq!(
        std::fs::read_to_string(dir.join("f.txt")).unwrap().replace("\r\n", "\n"),
        "original\n",
        "discard de un archivo staged debe devolverlo también al contenido de HEAD"
    );
    let (_, cached) = {
        let o = Command::new("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(&dir)
            .output()
            .unwrap();
        (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned())
    };
    assert!(cached.trim().is_empty(), "discard debe dejar el índice limpio: {cached:?}");

    // Sin seguir: discard debe borrar el archivo del disco.
    std::fs::write(dir.join("nuevo.txt"), "x\n").unwrap();
    assert!(dir.join("nuevo.txt").exists());
    super::repo::discard(&dir, &["nuevo.txt".to_string()], &[], true).expect("discard untracked");
    assert!(!dir.join("nuevo.txt").exists(), "discard de un sin-seguir debe borrarlo");

    // Directorio sin seguir: `-d` es imprescindible, sin él `clean -f` deja
    // la carpeta intacta (comprobado en vivo).
    std::fs::create_dir(dir.join("carpeta_nueva")).unwrap();
    std::fs::write(dir.join("carpeta_nueva/x.txt"), "x\n").unwrap();
    super::repo::discard(&dir, &["carpeta_nueva/".to_string()], &[], true)
        .expect("discard untracked dir");
    assert!(
        !dir.join("carpeta_nueva").exists(),
        "discard de una carpeta sin seguir debe borrarla entera"
    );
}

/// Renombrado: descartar solo con la ruta nueva pierde el archivo por
/// completo (git no calcula renombrados en `restore`, a diferencia de
/// `diff`/`show`) — hay que pasar también la ruta vieja. Bug real
/// reproducido en vivo antes de arreglarlo.
#[test]
fn discard_renombrado_necesita_ruta_original() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-discard-ren-{}-{}",
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
    std::fs::write(dir.join("a.txt"), "contenido original\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "init"]);
    git(&["mv", "a.txt", "b.txt"]);

    // Sin orig_path: el bug real — b.txt se pierde (restaurado contra un
    // HEAD sin b.txt) y a.txt queda marcado para borrar encima.
    super::repo::discard(&dir, &["b.txt".to_string()], &[], false)
        .expect("discard sin orig_path (reproduce el bug)");
    assert!(
        !dir.join("a.txt").exists() && !dir.join("b.txt").exists(),
        "reproduce el bug: ambos archivos deberían haber desaparecido"
    );

    // Recompone el escenario y repite con orig_path: debe recuperar a.txt tal
    // cual estaba, índice limpio.
    git(&["checkout", "-q", "HEAD", "--", "a.txt"]);
    git(&["reset", "-q"]);
    git(&["mv", "a.txt", "b.txt"]);
    super::repo::discard(&dir, &["b.txt".to_string()], &["a.txt".to_string()], false)
        .expect("discard con orig_path");
    assert!(dir.join("a.txt").exists(), "a.txt debe volver a existir");
    assert!(!dir.join("b.txt").exists(), "b.txt no debe quedar en el árbol de trabajo");
    assert_eq!(
        std::fs::read_to_string(dir.join("a.txt")).unwrap().replace("\r\n", "\n"),
        "contenido original\n"
    );
    let (_, status_out) = {
        let o = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&dir)
            .output()
            .unwrap();
        (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned())
    };
    assert!(status_out.trim().is_empty(), "el árbol debe quedar limpio: {status_out:?}");
}

/// Recorre el flujo que hace la UI (status → stage de las rutas de status →
/// commit → status limpio → log con el commit nuevo arriba), usando solo la
/// capa `repo`. Es lo más cerca que se puede estar del camino de los comandos
/// Tauri sin levantar la app.
#[test]
fn flujo_ui_status_stage_commit() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-flujo-{}-{}",
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
    std::fs::write(dir.join("base.txt"), "0\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);

    // Dos archivos nuevos + una modificación.
    std::fs::write(dir.join("base.txt"), "0\n1\n").unwrap();
    std::fs::write(dir.join("nuevo a.txt"), "a\n").unwrap();
    std::fs::write(dir.join("-nuevo.txt"), "b\n").unwrap();

    let info = super::repo::open(&dir).expect("open");
    let st = super::repo::status(&dir).expect("status");
    assert_eq!(st.entries.len(), 3);

    let paths: Vec<String> = st.entries.iter().map(|e| e.path.clone()).collect();
    super::repo::stage(&dir, &paths).expect("stage");
    super::repo::commit(&dir, "cambios de la UI", false).expect("commit");

    let st2 = super::repo::status(&dir).expect("status 2");
    assert!(st2.entries.is_empty(), "el árbol debería quedar limpio: {st2:?}");

    let log = super::repo::log(&dir, 0, 10, &super::repo::LogFilter::None, None).expect("log");
    assert_eq!(log[0].subject, "cambios de la UI");
    assert_eq!(log[0].parents.len(), 1);
    assert_eq!(info.head.as_deref(), Some("master"));

    // Amend: cambia el mensaje del de arriba sin crear otro.
    super::repo::commit(&dir, "cambios de la UI (amend)", true).expect("amend");
    let log2 = super::repo::log(&dir, 0, 10, &super::repo::LogFilter::None, None).expect("log 3");
    assert_eq!(log2.len(), log.len(), "amend no debe añadir un commit");
    assert_eq!(log2[0].subject, "cambios de la UI (amend)");
}

/// fetch/pull/push contra un `origin` bare local: ejercita la fontanería de
/// red sin depender de conectividad ni credenciales reales.
#[test]
fn fetch_pull_push_contra_origin_bare_local() {
    use std::path::PathBuf;
    use std::process::Command;

    let base: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-remote-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let origin = base.join("origin.git");
    let clone_a = base.join("a");
    let clone_b = base.join("b");
    std::fs::create_dir_all(&origin).unwrap();
    let _guard = scopeguard(&base);

    let git = |dir: &std::path::Path, args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned()))
            .unwrap_or((false, String::new()))
    };
    if !git(&origin, &["init", "-q", "--bare", "-b", "master"]).0 {
        eprintln!("git no disponible, se salta el test");
        return;
    }

    // clone_a: primer autor, empuja el commit inicial al bare.
    assert!(git(&base, &["clone", "-q", origin.to_str().unwrap(), "a"]).0);
    git(&clone_a, &["config", "user.email", "a@t"]);
    git(&clone_a, &["config", "user.name", "a"]);
    std::fs::write(clone_a.join("f.txt"), "0\n").unwrap();
    git(&clone_a, &["add", "-A"]);
    git(&clone_a, &["commit", "-q", "-m", "inicial"]);
    assert!(super::repo::push(&clone_a).is_ok(), "push del commit inicial (ya tiene upstream tras el clone)");

    // clone_b: segundo autor, aporta un commit propio.
    assert!(git(&base, &["clone", "-q", origin.to_str().unwrap(), "b"]).0);
    git(&clone_b, &["config", "user.email", "b@t"]);
    git(&clone_b, &["config", "user.name", "b"]);
    std::fs::write(clone_b.join("g.txt"), "0\n").unwrap();
    git(&clone_b, &["add", "-A"]);
    git(&clone_b, &["commit", "-q", "-m", "de b"]);
    super::repo::push(&clone_b).expect("push de b");

    // clone_a: sin fetch, no debería ver el commit de b.
    let st_before = super::repo::status(&clone_a).expect("status antes de fetch");
    assert_eq!(st_before.behind, 0, "sin fetch, ahead/behind no debe verse afectado");

    super::repo::fetch(&clone_a).expect("fetch");
    let st_after = super::repo::status(&clone_a).expect("status tras fetch");
    assert_eq!(st_after.behind, 1, "tras el fetch, behind debe reflejar el commit de b");

    super::repo::pull(&clone_a).expect("pull (fast-forward)");
    assert!(clone_a.join("g.txt").exists(), "pull debió traer el archivo de b");
    let st_clean = super::repo::status(&clone_a).expect("status tras pull");
    assert_eq!(st_clean.ahead, 0);
    assert_eq!(st_clean.behind, 0);

    // Divergencia real: b vuelve a comitear, a comitea algo distinto sin fetch.
    std::fs::write(clone_b.join("h.txt"), "0\n").unwrap();
    git(&clone_b, &["add", "-A"]);
    git(&clone_b, &["commit", "-q", "-m", "de b otra vez"]);
    super::repo::push(&clone_b).expect("push de b, 2a vez");

    std::fs::write(clone_a.join("i.txt"), "0\n").unwrap();
    git(&clone_a, &["add", "-A"]);
    git(&clone_a, &["commit", "-q", "-m", "de a, diverge"]);
    super::repo::fetch(&clone_a).expect("fetch antes de pull divergente");
    assert!(
        super::repo::pull(&clone_a).is_err(),
        "pull --ff-only debe fallar (con mensaje, no colgarse) cuando diverge"
    );
}

/// `push` en HEAD desprendido falla con mensaje legible, sin llegar a
/// invocar `git push -u <remoto> <rama>` con una rama inexistente.
#[test]
fn push_en_head_desprendido_falla_legible() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-detached-{}-{}",
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
    std::fs::write(dir.join("f.txt"), "0\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "init"]);
    git(&["checkout", "-q", "--detach", "HEAD"]);

    let err = super::repo::push(&dir).expect_err("HEAD desprendido debe rechazar el push");
    assert!(
        matches!(err, super::error::GitError::Parse(_)),
        "se esperaba un error de parseo/precondición, no uno de red: {err:?}"
    );
}

/// stash: guardar (con y sin `-u`), listar, aplicar/pop y borrar, verificado
/// contra `git stash list` / `git status` reales.
#[test]
fn stash_push_list_apply_drop() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-stash-{}-{}",
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
            .output()
            .map(|o| (o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned()))
            .unwrap_or((false, String::new()))
    };
    if !git(&["init", "-q", "-b", "master"]).0 {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join("base.txt"), "0\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);

    // Un cambio a un archivo seguido + uno nuevo sin seguir.
    std::fs::write(dir.join("base.txt"), "0\n1\n").unwrap();
    std::fs::write(dir.join("nuevo.txt"), "x\n").unwrap();

    super::repo::stash_push(&dir, "con untracked", true).expect("stash -u");
    let (_, st_out) = git(&["status", "--porcelain"]);
    assert!(st_out.trim().is_empty(), "el árbol debe quedar limpio tras -u: {st_out:?}");

    let list = super::repo::stash_list(&dir).expect("stash list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].index, 0);
    // `%gs` de git incluye el prefijo "On <rama>: " — no es un mensaje limpio,
    // es el mismo texto que enseña `git stash list`.
    assert_eq!(list[0].message, "On master: con untracked");

    super::repo::stash_apply(&dir, 0, true).expect("stash pop");
    assert!(dir.join("nuevo.txt").exists(), "pop debió traer el archivo sin seguir");
    let list2 = super::repo::stash_list(&dir).expect("stash list tras pop");
    assert!(list2.is_empty(), "pop debe quitar el stash de la lista");

    // Sin -u: el archivo sin seguir queda fuera del stash.
    std::fs::write(dir.join("base.txt"), "0\n2\n").unwrap();
    std::fs::write(dir.join("otro.txt"), "y\n").unwrap();
    super::repo::stash_push(&dir, "sin untracked", false).expect("stash sin -u");
    assert!(dir.join("otro.txt").exists(), "sin -u, lo sin seguir no debe guardarse");
    super::repo::stash_drop(&dir, 0).expect("stash drop");
    assert!(super::repo::stash_list(&dir).expect("stash list final").is_empty());
}

/// cherry-pick limpio: el commit aparece en la rama destino con el mismo
/// mensaje, verificado contra `git log` real.
#[test]
fn cherry_pick_limpio() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-cherry-{}-{}",
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
    std::fs::write(dir.join("base.txt"), "0\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);
    git(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(dir.join("feature.txt"), "f\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "commit de feature"]);
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&dir)
        .output()
        .unwrap();
    let hash = String::from_utf8_lossy(&out.stdout).trim().to_string();

    git(&["checkout", "-q", "master"]);
    super::repo::cherry_pick(&dir, &hash).expect("cherry-pick limpio");
    let log = super::repo::log(&dir, 0, 5, &super::repo::LogFilter::None, None).expect("log");
    assert_eq!(log[0].subject, "commit de feature");
    assert!(dir.join("feature.txt").exists());

    assert!(super::repo::cherry_pick(&dir, "no-hex").is_err());
}

/// Rebase que provoca un conflicto a propósito: `op_state` lo detecta,
/// `op_abort` devuelve el repo EXACTAMENTE al `HEAD` previo (mismo hash), y
/// en una segunda pasada resolver a mano + `op_continue` termina el rebase.
#[test]
fn rebase_conflicto_abort_y_continue() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-rebase-{}-{}",
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
    let git_out = |args: &[&str]| -> String {
        let o = Command::new("git").args(args).current_dir(&dir).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    if !git(&["init", "-q", "-b", "master"]) {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join("f.txt"), "base\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);

    // master avanza modificando f.txt.
    std::fs::write(dir.join("f.txt"), "base\nmaster\n").unwrap();
    git(&["commit", "-qam", "cambio en master"]);

    // feature, desde el commit base, modifica la MISMA línea de forma
    // incompatible: garantiza conflicto al rebasar.
    git(&["checkout", "-q", "-b", "feature", "HEAD~1"]);
    std::fs::write(dir.join("f.txt"), "base\nfeature\n").unwrap();
    git(&["commit", "-qam", "cambio en feature"]);

    assert!(super::repo::op_state(&dir).expect("op_state limpio").is_none());

    let head_before = git_out(&["rev-parse", "HEAD"]);
    let result = super::repo::rebase(&dir, "master");
    assert!(result.is_err(), "el rebase debe fallar por conflicto, no colgarse");

    let state = super::repo::op_state(&dir).expect("op_state").expect("debe haber un rebase en curso");
    assert_eq!(state.kind, "rebase");

    // Abort: HEAD vuelve exactamente al commit de antes del rebase.
    super::repo::op_abort(&dir).expect("op_abort");
    assert!(super::repo::op_state(&dir).expect("op_state tras abort").is_none());
    assert_eq!(git_out(&["rev-parse", "HEAD"]), head_before, "abort debe dejar HEAD igual que antes");

    // Segunda pasada: rebase, resolver a mano, continuar.
    super::repo::rebase(&dir, "master").expect_err("vuelve a conflictuar igual");
    assert!(super::repo::op_state(&dir).expect("op_state 2").is_some());
    std::fs::write(dir.join("f.txt"), "base\nmaster\nfeature\n").unwrap();
    git(&["add", "-A"]);
    super::repo::op_continue(&dir).expect("op_continue tras resolver a mano");
    assert!(super::repo::op_state(&dir).expect("op_state final").is_none());

    let log = super::repo::log(&dir, 0, 10, &super::repo::LogFilter::None, None).expect("log final");
    assert!(log.iter().any(|c| c.subject == "cambio en feature"), "el commit rebasado debe seguir en el historial");
    let content = std::fs::read_to_string(dir.join("f.txt")).unwrap();
    assert_eq!(content, "base\nmaster\nfeature\n");
}

/// Merge explícito: limpio (rama divergida → commit de fusión con dos padres),
/// con conflicto (`op_state` lo ve como "merge", `op_abort` devuelve HEAD al
/// hash exacto de antes, `op_continue` termina tras resolver a mano) y con una
/// ref que no es `refs/heads|remotes/…` (rechazada antes de invocar git).
/// Es la primera vez que la maquinaria de `MERGE_HEAD` de `op_*` se ejercita.
#[test]
fn merge_limpio_conflicto_abort_y_continue() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-merge-{}-{}",
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
    let git_out = |args: &[&str]| -> String {
        let o = Command::new("git").args(args).current_dir(&dir).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    if !git(&["init", "-q", "-b", "master"]) {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join("f.txt"), "base\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);

    // Rama `limpia` toca OTRO archivo; master avanza en f.txt → divergen sin conflicto.
    git(&["checkout", "-q", "-b", "limpia"]);
    std::fs::write(dir.join("g.txt"), "g\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "commit de limpia"]);
    git(&["checkout", "-q", "master"]);
    std::fs::write(dir.join("f.txt"), "base\nmaster\n").unwrap();
    git(&["commit", "-qam", "cambio en master"]);

    super::repo::merge(&dir, "refs/heads/limpia").expect("merge limpio");
    let padres = git_out(&["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(padres.split_whitespace().count(), 3, "commit de fusión = hash + 2 padres: {padres}");
    assert!(dir.join("g.txt").exists());
    assert!(super::repo::op_state(&dir).expect("op_state").is_none());

    // Rama `choca`, desde el commit raíz, añade en f.txt una línea distinta a la
    // que añadió master → conflicto garantizado.
    let raiz = git_out(&["rev-list", "--max-parents=0", "HEAD"]);
    git(&["checkout", "-q", "-b", "choca", &raiz]);
    std::fs::write(dir.join("f.txt"), "base\nchoca\n").unwrap();
    git(&["commit", "-qam", "cambio en choca"]);
    git(&["checkout", "-q", "master"]);
    let head_before = git_out(&["rev-parse", "HEAD"]);

    assert!(
        super::repo::merge(&dir, "refs/heads/choca").is_err(),
        "el merge debe fallar por conflicto, no colgarse"
    );
    let state = super::repo::op_state(&dir).expect("op_state").expect("debe haber un merge en curso");
    assert_eq!(state.kind, "merge");

    super::repo::op_abort(&dir).expect("op_abort");
    assert!(super::repo::op_state(&dir).expect("tras abort").is_none());
    assert_eq!(git_out(&["rev-parse", "HEAD"]), head_before, "abort deja HEAD igual que antes");

    super::repo::merge(&dir, "refs/heads/choca").expect_err("vuelve a conflictuar igual");
    std::fs::write(dir.join("f.txt"), "base\nmaster\nchoca\n").unwrap();
    git(&["add", "-A"]);
    super::repo::op_continue(&dir).expect("op_continue tras resolver a mano");
    assert!(super::repo::op_state(&dir).expect("final").is_none());
    let padres = git_out(&["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(padres.split_whitespace().count(), 3, "el merge resuelto tiene dos padres");

    // Refs que no son de rama: rechazadas sin llegar a git (`--abort` sería una opción).
    for mala in ["", "--abort", "choca", "tags/v1", "refs/tags/v1"] {
        assert!(super::repo::merge(&dir, mala).is_err(), "debe rechazar {mala:?}");
    }
}

/// Crear/renombrar/borrar ramas y crear/borrar tags, contrastado contra git
/// real: qué se crea, dónde queda HEAD, y que un nombre que git leería como
/// opción (`-x`) o que no es un refname válido se rechaza sin tocar nada.
#[test]
fn ramas_y_tags_crear_renombrar_borrar() {
    use super::error::GitError;
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-refops-{}-{}",
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
    let git_out = |args: &[&str]| -> String {
        let o = Command::new("git").args(args).current_dir(&dir).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    if !git(&["init", "-q", "-b", "master"]) {
        eprintln!("git no disponible, se salta el test");
        return;
    }
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join("a.txt"), "1\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "c1"]);
    let c1 = git_out(&["rev-parse", "HEAD"]);
    std::fs::write(dir.join("a.txt"), "2\n").unwrap();
    git(&["commit", "-qam", "c2"]);
    let names = || -> Vec<String> {
        let mut v: Vec<String> = super::repo::branches(&dir)
            .unwrap()
            .into_iter()
            .map(|b| b.name)
            .collect();
        v.sort();
        v
    };
    let actual = || git_out(&["branch", "--show-current"]);

    // --- crear: en HEAD y en un commit concreto; cambia a la rama nueva ---
    super::repo::create_branch(&dir, "nueva", None).expect("crear en HEAD");
    assert_eq!(actual(), "nueva");
    super::repo::create_branch(&dir, "vieja", Some(&c1)).expect("crear en un commit");
    assert_eq!(actual(), "vieja");
    assert_eq!(git_out(&["rev-parse", "HEAD"]), c1);
    for mala in ["", "-x", "--detach", "a b", "a..b", "x.lock", "a~1"] {
        assert!(super::repo::create_branch(&dir, mala, None).is_err(), "debe rechazar {mala:?}");
    }
    assert!(super::repo::create_branch(&dir, "otra", Some("--orphan")).is_err(), "punto de partida no hex");
    assert_eq!(actual(), "vieja", "los rechazos no tocan HEAD");
    assert_eq!(names(), vec!["master", "nueva", "vieja"]);

    // --- renombrar ---
    super::repo::rename_branch(&dir, "nueva", "renombrada").expect("renombrar");
    assert_eq!(names(), vec!["master", "renombrada", "vieja"]);
    assert!(super::repo::rename_branch(&dir, "no-existe", "z").is_err());
    assert!(super::repo::rename_branch(&dir, "renombrada", "a b").is_err());
    assert!(super::repo::rename_branch(&dir, "renombrada", "-x").is_err());
    assert!(super::repo::rename_branch(&dir, "renombrada", "master").is_err(), "no pisa una existente");
    assert_eq!(names(), vec!["master", "renombrada", "vieja"]);

    // --- borrar: una rama fusionada en HEAD se borra sin forzar ---
    git(&["checkout", "-q", "master"]);
    super::repo::delete_branch(&dir, "vieja", false).expect("vieja está en master: fusionada");
    // …una con un commit propio NO, hasta que se fuerce.
    git(&["checkout", "-q", "-b", "propia"]);
    std::fs::write(dir.join("p.txt"), "p\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "solo en propia"]);
    git(&["checkout", "-q", "master"]);
    let e = super::repo::delete_branch(&dir, "propia", false).expect_err("no fusionada");
    assert!(matches!(e, GitError::NotMerged(_)), "kind not_merged, no un error genérico: {e:?}");
    assert!(names().contains(&"propia".to_string()), "el rechazo no borra nada");
    super::repo::delete_branch(&dir, "propia", true).expect("forzado");
    assert!(!names().contains(&"propia".to_string()));
    // Inexistente, con forma de opción, y la rama activa.
    assert!(super::repo::delete_branch(&dir, "no-existe", true).is_err());
    assert!(super::repo::delete_branch(&dir, "-D", true).is_err());
    assert!(super::repo::delete_branch(&dir, "master", true).is_err(), "no borra la rama activa");
    assert!(names().contains(&"master".to_string()));

    // --- tags: en HEAD y en un commit; nombres malos; borrar ---
    super::repo::create_tag(&dir, "v1", None).expect("tag en HEAD");
    super::repo::create_tag(&dir, "v0", Some(&c1)).expect("tag en un commit");
    assert_eq!(git_out(&["rev-parse", "v0^{commit}"]), c1);
    for mala in ["", "-x", "a b", "a..b"] {
        assert!(super::repo::create_tag(&dir, mala, None).is_err(), "debe rechazar {mala:?}");
    }
    assert!(super::repo::create_tag(&dir, "v1", None).is_err(), "no pisa un tag existente");
    assert!(super::repo::create_tag(&dir, "z", Some("no-hex")).is_err());
    // El chip sale como tag en el log real.
    let log = super::repo::log(&dir, 0, 5, &super::repo::LogFilter::None, None).unwrap();
    assert!(log[0].refs.iter().any(|c| c.name == "v1" && c.kind == "tag"));
    super::repo::delete_tag(&dir, "v1").expect("borrar tag");
    assert_eq!(git_out(&["tag", "--list", "v1"]), "");
    assert!(super::repo::delete_tag(&dir, "v1").is_err(), "ya no existe");
    assert!(super::repo::delete_tag(&dir, "-d").is_err());
}

/// Historial de un archivo: solo los commits que lo tocan, atravesando un
/// renombrado (`--follow`), con `--all` (un archivo puede cambiar en otra rama)
/// y con la ruta tomada LITERAL: `[x].txt` es un glob para un pathspec normal.
#[test]
fn log_de_un_archivo_sigue_renombrados_y_es_literal() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-filelog-{}-{}",
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
    git(&["config", "core.autocrlf", "false"]);
    let w = |f: &str, c: &str, m: &str| {
        std::fs::write(dir.join(f), c).unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", m]);
    };
    // El contenido es largo a propósito: la detección de renombrado necesita similitud.
    let base = "uno\ndos\ntres\ncuatro\ncinco\nseis\nsiete\nocho\n";
    w("a.txt", base, "A crea a");
    w("otro.txt", "x\n", "B otro");
    git(&["checkout", "-q", "-b", "rama"]);
    w("a.txt", &format!("{base}rama\n"), "C a en rama");
    git(&["checkout", "-q", "master"]);
    w("q.txt", "q\n", "D q");
    git(&["merge", "-q", "--no-edit", "rama"]);
    git(&["mv", "a.txt", "b.txt"]);
    git(&["commit", "-q", "-m", "E renombra a->b"]);
    w("b.txt", &format!("{base}rama\nfin\n"), "F toca b");
    w("[x].txt", "glob\n", "G crea [x]");

    let asuntos = |f: &str| -> Vec<String> {
        super::repo::log(&dir, 0, 20, &super::repo::LogFilter::File(f.to_string()), None)
            .expect("log de archivo")
            .into_iter()
            .map(|c| c.subject)
            .collect()
    };
    // Sigue el renombrado: aparecen C y A, de antes de que se llamara b.txt.
    assert_eq!(
        asuntos("b.txt"),
        vec!["F toca b", "E renombra a->b", "C a en rama", "A crea a"]
    );
    // Un archivo que solo se tocó en una rama concreta sí sale (por `--all`).
    assert_eq!(asuntos("q.txt"), vec!["D q"]);
    // Literal: `[x].txt` no es el glob «x.txt» y solo devuelve su propio commit…
    assert_eq!(asuntos("[x].txt"), vec!["G crea [x]"]);
    // …y un nombre con forma de opción o de pathspec mágico no filtra a lo loco.
    assert!(asuntos("--all").is_empty());
    assert!(asuntos(":(top)b.txt").is_empty());
    // Ruta vacía o con NUL: rechazada.
    for mala in ["", "a\0b"] {
        assert!(
            super::repo::log(&dir, 0, 5, &super::repo::LogFilter::File(mala.to_string()), None).is_err(),
            "debe rechazar {mala:?}"
        );
    }
}

/// Crea un repo temporal con git configurado, para los tests de reset/revert.
fn repo_temporal(prefijo: &str) -> Option<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "gitpad-{prefijo}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let ok = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if !ok(&["init", "-q", "-b", "master"]) {
        return None;
    }
    ok(&["config", "user.email", "t@t"]);
    ok(&["config", "user.name", "t"]);
    ok(&["config", "core.autocrlf", "false"]);
    Some(dir)
}

/// Revert: limpio (deja un commit nuevo, no reescribe historia), con conflicto
/// (`op_state` = "revert" por `REVERT_HEAD`; abort vuelve al hash exacto; continue
/// termina tras resolver a mano) y con un commit de fusión, que git rechaza sin
/// `-m` y que aquí no debe dejar ninguna operación a medias.
#[test]
fn revert_limpio_conflicto_abort_y_continue() {
    let Some(dir) = repo_temporal("revert") else {
        eprintln!("git no disponible, se salta el test");
        return;
    };
    let _guard = scopeguard(&dir);
    let git = |args: &[&str]| {
        std::process::Command::new("git").args(args).current_dir(&dir).status().unwrap().success()
    };
    let git_out = |args: &[&str]| -> String {
        let o = std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    let w = |f: &str, c: &str, m: &str| {
        std::fs::write(dir.join(f), c).unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", m]);
        git_out(&["rev-parse", "HEAD"])
    };

    w("a.txt", "1\n", "base");
    let x = w("a.txt", "2\n", "X: a=2");
    let y = w("b.txt", "y\n", "Y: otro archivo");

    // Limpio: revertir Y (toca otro archivo) deja un commit nuevo encima.
    super::repo::revert(&dir, &y).expect("revert limpio");
    assert!(!dir.join("b.txt").exists(), "el revert deshace el cambio");
    assert!(git_out(&["log", "-1", "--format=%s"]).starts_with("Revert"), "commit nuevo, no reescribe");
    assert_eq!(git_out(&["rev-list", "--count", "HEAD"]), "4", "la historia crece, no se reescribe");

    // Conflicto: revertir X (a: 1→2) cuando un commit posterior ya cambió esa línea.
    w("a.txt", "3\n", "Z: a=3");
    let antes = git_out(&["rev-parse", "HEAD"]);
    assert!(super::repo::revert(&dir, &x).is_err(), "conflicto: falla, no se cuelga");
    let st = super::repo::op_state(&dir).unwrap().expect("revert en curso");
    assert_eq!(st.kind, "revert");
    super::repo::op_abort(&dir).expect("abort");
    assert!(super::repo::op_state(&dir).unwrap().is_none());
    assert_eq!(git_out(&["rev-parse", "HEAD"]), antes, "abort deja HEAD exacto");

    assert!(super::repo::revert(&dir, &x).is_err());
    std::fs::write(dir.join("a.txt"), "resuelto\n").unwrap();
    git(&["add", "-A"]);
    super::repo::op_continue(&dir).expect("continue tras resolver a mano");
    assert!(super::repo::op_state(&dir).unwrap().is_none());
    assert!(git_out(&["log", "-1", "--format=%s"]).starts_with("Revert"));
    assert_eq!(git_out(&["show", "HEAD:a.txt"]), "resuelto");

    // Un commit de fusión: git exige `-m`. Error limpio, sin dejar nada a medias.
    git(&["checkout", "-q", "-b", "rama"]);
    w("r.txt", "r\n", "R en rama");
    git(&["checkout", "-q", "master"]);
    w("m.txt", "m\n", "M en master");
    git(&["merge", "-q", "--no-edit", "rama"]);
    let merge = git_out(&["rev-parse", "HEAD"]);
    assert!(super::repo::revert(&dir, &merge).is_err(), "revertir una fusión sin -m falla");
    assert!(super::repo::op_state(&dir).unwrap().is_none(), "y no deja operación a medias");

    // Entrada que no es un hash.
    for mala in ["", "--abort", "master", "HEAD"] {
        assert!(super::repo::revert(&dir, mala).is_err(), "debe rechazar {mala:?}");
    }
}

/// Reset a un commit: qué queda en HEAD, en el índice y en el árbol de trabajo
/// según el modo, contrastado con git real. `hard` descarta lo modificado pero
/// NO los archivos sin seguir.
#[test]
fn reset_soft_mixed_y_hard() {
    let Some(dir) = repo_temporal("reset") else {
        eprintln!("git no disponible, se salta el test");
        return;
    };
    let _guard = scopeguard(&dir);
    let git = |args: &[&str]| {
        std::process::Command::new("git").args(args).current_dir(&dir).status().unwrap().success()
    };
    let git_out = |args: &[&str]| -> String {
        let o = std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    let w = |f: &str, c: &str, m: &str| {
        std::fs::write(dir.join(f), c).unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", m]);
        git_out(&["rev-parse", "HEAD"])
    };
    let c1 = w("a.txt", "1\n", "c1");
    w("a.txt", "2\n", "c2");
    let c3 = w("a.txt", "3\n", "c3");
    let leer = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap();

    // soft: HEAD se mueve; el índice conserva los cambios (staged) y el árbol también.
    super::repo::reset(&dir, &c1, "soft").expect("soft");
    assert_eq!(git_out(&["rev-parse", "HEAD"]), c1);
    assert_eq!(git_out(&["diff", "--cached", "--name-only"]), "a.txt", "soft deja los cambios en el índice");
    assert_eq!(leer("a.txt"), "3\n");

    // mixed: HEAD y índice se mueven; el árbol conserva el contenido, sin staged.
    git(&["reset", "-q", "--hard", &c3]);
    super::repo::reset(&dir, &c1, "mixed").expect("mixed");
    assert_eq!(git_out(&["rev-parse", "HEAD"]), c1);
    assert_eq!(git_out(&["diff", "--cached", "--name-only"]), "", "mixed vacía el índice");
    assert_eq!(leer("a.txt"), "3\n", "pero no toca el árbol de trabajo");

    // hard: todo vuelve a c1, también un cambio sin guardar; el archivo sin seguir sobrevive.
    git(&["reset", "-q", "--hard", &c3]);
    std::fs::write(dir.join("a.txt"), "sucio\n").unwrap();
    std::fs::write(dir.join("sin_seguir.txt"), "u\n").unwrap();
    super::repo::reset(&dir, &c1, "hard").expect("hard");
    assert_eq!(git_out(&["rev-parse", "HEAD"]), c1);
    assert_eq!(leer("a.txt"), "1\n", "hard descarta el cambio sin guardar");
    assert!(dir.join("sin_seguir.txt").exists(), "…pero no borra archivos sin seguir");

    // Entradas inválidas: modo desconocido o con forma de opción, hash que no es hex,
    // y un hash bien formado que no existe.
    for modo in ["", "--hard", "keep", "HARD"] {
        assert!(super::repo::reset(&dir, &c1, modo).is_err(), "modo {modo:?}");
    }
    for mala in ["", "--soft", "master", "HEAD"] {
        assert!(super::repo::reset(&dir, mala, "soft").is_err(), "hash {mala:?}");
    }
    assert!(super::repo::reset(&dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "hard").is_err());
    assert_eq!(git_out(&["rev-parse", "HEAD"]), c1, "los rechazos no mueven HEAD");
}

/// Mientras hay una operación en curso, `op_continue`/`op_abort` sin ninguna
/// pendiente deben fallar con mensaje, no entrar en pánico.
#[test]
fn op_continue_abort_sin_operacion_en_curso_es_error() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-noop-{}-{}",
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
        eprintln!("git no disponible, se salta el test");
        return;
    }

    assert!(super::repo::op_continue(&dir).is_err());
    assert!(super::repo::op_abort(&dir).is_err());
}

/// `checkout` y `rebase` reciben una ref del frontend. Una ref que empiece por
/// `-` no debe leerse como opción de git: `--detach` y `--root` TIENEN éxito
/// si se interpretan como flags (desprenden HEAD / reescriben la rama), así que
/// discriminan mejor que un flag inválido, que falla con o sin el arreglo.
/// Y el cambio de rama normal sigue funcionando (`--end-of-options`, no `--`:
/// `git checkout -- feat` restauraría un *archivo* llamado `feat`).
#[test]
fn checkout_y_rebase_no_leen_la_ref_como_opcion() {
    use std::path::PathBuf;
    use std::process::Command;

    let dir: PathBuf = std::env::temp_dir().join(format!(
        "gitpad-eoo-{}-{}",
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
    std::fs::write(dir.join("base.txt"), "0\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);
    git(&["branch", "feat"]);
    let rama = || {
        let out = Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(&dir)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    // El cambio de rama de siempre sigue funcionando.
    super::repo::checkout(&dir, "feat").expect("checkout normal");
    assert_eq!(rama(), "feat");

    // `--detach` como flag desprendería HEAD (rama vacía). Debe fallar y no tocar nada.
    assert!(super::repo::checkout(&dir, "--detach").is_err());
    assert_eq!(rama(), "feat", "HEAD no debe desprenderse");

    // `--root` como flag rehace la rama entera (éxito, rc=0); como ref es inválida.
    assert!(super::repo::rebase(&dir, "--root").is_err());
    // Y un rebase normal sigue funcionando.
    super::repo::rebase(&dir, "master").expect("rebase normal");
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
    use std::process::Command;
    let repo = std::env::var("GITPAD_SMOKE_REPO").expect("define GITPAD_SMOKE_REPO");
    let info = super::repo::open(Path::new(&repo)).expect("open");
    let root = Path::new(&info.root);

    let log = super::repo::log(root, 0, 10, &super::repo::LogFilter::None, None).expect("log");
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

    // El diff de HEAD debe coincidir carácter a carácter con `git show`.
    let ours = super::repo::commit_diff(root, &log[0].hash).expect("commit_diff");
    let theirs = Command::new("git")
        .args([
            "-C",
            &info.root,
            "show",
            "--format=",
            "--no-color",
            "--no-ext-diff",
            "-U3",
            &log[0].hash,
        ])
        .output()
        .expect("git show");
    let theirs = String::from_utf8_lossy(&theirs.stdout);
    assert_eq!(ours, theirs, "commit_diff difiere de `git show`");
    eprintln!("commit_diff HEAD: {} bytes, == git show", ours.len());

    // Y el de un archivo con cambios, si lo hay.
    if let Some(e) = st
        .entries
        .iter()
        .find(|e| e.unstaged != "." && e.unstaged != "?")
    {
        let ours = super::repo::file_diff(root, &e.path, false).expect("file_diff");
        let theirs = Command::new("git")
            .args([
                "-C",
                &info.root,
                "diff",
                "--no-color",
                "--no-ext-diff",
                "-U3",
                "--",
                &e.path,
            ])
            .output()
            .expect("git diff");
        assert_eq!(
            ours,
            String::from_utf8_lossy(&theirs.stdout),
            "file_diff difiere de `git diff` para {}",
            e.path
        );
        eprintln!("file_diff {}: {} bytes, == git diff", e.path, ours.len());
    }
}

/// Lo mismo, pero pasando por `git log` de verdad (no por una cadena escrita a
/// mano): una rama y un tag `v1` en el mismo commit salen como dos chips.
#[test]
fn log_real_distingue_tag_y_rama_homonimos() {
    use std::process::Command;

    let dir = std::env::temp_dir().join(format!(
        "gitpad-homo-{}-{}",
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
    std::fs::write(dir.join("a.txt"), "1\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "c1"]);
    git(&["branch", "v1"]);
    git(&["tag", "v1"]);
    git(&["branch", "feature/x"]);

    let log = super::repo::log(&dir, 0, 5, &super::repo::LogFilter::None, None).expect("log");
    let mut got: Vec<(String, String)> =
        log[0].refs.iter().map(|c| (c.name.clone(), c.kind.clone())).collect();
    got.sort();
    assert_eq!(
        got,
        vec![par("feature/x", "local"), par("master", "head"), par("v1", "local"), par("v1", "tag")]
    );
}

/// (nombre, tipo) de cada chip, para comparar sin depender del orden de campos.
fn chips(raw: &str) -> Vec<(String, String)> {
    super::repo::parse_refs_for_test(raw)
        .into_iter()
        .map(|c| (c.name, c.kind))
        .collect()
}

fn par(n: &str, k: &str) -> (String, String) {
    (n.to_string(), k.to_string())
}

#[test]
fn refs_se_limpian_los_prefijos_y_llevan_tipo() {
    // `%D` con `--decorate=full`: cada ref viene cualificada, así que el tipo
    // sale del propio texto y no hay que deducirlo contrastando con la lista.
    let r = chips("HEAD -> refs/heads/master, refs/remotes/origin/master, tag: refs/tags/v1.0");
    assert_eq!(
        r,
        vec![par("master", "head"), par("origin/master", "remote"), par("v1.0", "tag")]
    );
}

#[test]
fn refs_head_desprendido_se_descarta() {
    // Con HEAD desprendido, %D da "HEAD" suelto (sin "HEAD -> "): ya se
    // muestra aparte en la topbar, no debe salir como chip duplicado.
    let r = chips("HEAD, tag: refs/tags/v1.0");
    assert_eq!(r, vec![par("v1.0", "tag")]);
}

/// El fallo que motivó los tipos: una rama y un tag con el mismo nombre en el
/// mismo commit salían como dos chips de rama (el tag desaparecía). Además una
/// rama local con `/` no se confunde con una remota.
#[test]
fn refs_rama_y_tag_homonimos_y_con_barra() {
    let r = chips(
        "HEAD -> refs/heads/master, tag: refs/tags/v1, refs/heads/v1, \
         refs/heads/feature/x, refs/remotes/origin/feature/x, refs/remotes/origin/HEAD, refs/stash",
    );
    assert_eq!(
        r,
        vec![
            par("master", "head"),
            par("v1", "tag"),
            par("v1", "local"),
            par("feature/x", "local"),
            par("origin/feature/x", "remote"),
            par("origin/HEAD", "remote"),
            par("refs/stash", "other"),
        ]
    );
}

#[test]
fn branches_parsea_locales_remotas_y_worktree() {
    use super::repo::parse_branch_lines_for_test as parse;
    const FS: char = '\u{1f}';
    let raw = format!(
        "refs/heads/master{FS}origin/master{FS}/repo{FS}*\n\
         refs/heads/wt-target{FS}{FS}/otro/worktree{FS}\n\
         refs/remotes/origin/master{FS}{FS}{FS}\n\
         refs/remotes/origin/HEAD{FS}{FS}{FS}\n"
    );
    let branches = parse(&raw).expect("parseo de ramas");
    assert_eq!(branches.len(), 3, "origin/HEAD (puntero simbólico) debe descartarse");

    let master = branches.iter().find(|b| b.name == "master").unwrap();
    assert!(master.is_head);
    assert!(!master.is_remote);
    assert_eq!(master.checkout_arg, "master");
    assert_eq!(master.upstream.as_deref(), Some("origin/master"));
    assert_eq!(master.worktree_path.as_deref(), Some("/repo"));

    let wt = branches.iter().find(|b| b.name == "wt-target").unwrap();
    assert!(
        !wt.is_head && wt.worktree_path.is_some(),
        "abierta en otro worktree y no es HEAD aquí: debe salir bloqueable"
    );

    let remote = branches
        .iter()
        .find(|b| b.name == "origin/master")
        .unwrap();
    assert!(remote.is_remote);
    // Sin el prefijo del remoto: así `checkout` dispara el DWIM en vez de
    // dejar HEAD "detached" (comprobado en vivo contra git 2.55).
    assert_eq!(remote.checkout_arg, "master");
}

#[test]
fn branches_campos_incompletos_es_error() {
    use super::repo::parse_branch_lines_for_test as parse;
    assert!(parse("refs/heads/master\n").is_err());
}
