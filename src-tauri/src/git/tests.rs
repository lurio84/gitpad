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

    let log = super::repo::log(&dir, 0, 50, &super::repo::LogFilter::None).expect("log de repo vacío");
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

    let log = super::repo::log(&dir, 0, 10, &super::repo::LogFilter::None).expect("log");
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

    let log = super::repo::log(&dir, 0, 10, &super::repo::LogFilter::None).expect("log");
    assert_eq!(log[0].subject, "cambios de la UI");
    assert_eq!(log[0].parents.len(), 1);
    assert_eq!(info.head.as_deref(), Some("master"));

    // Amend: cambia el mensaje del de arriba sin crear otro.
    super::repo::commit(&dir, "cambios de la UI (amend)", true).expect("amend");
    let log2 = super::repo::log(&dir, 0, 10, &super::repo::LogFilter::None).expect("log 3");
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
    let log = super::repo::log(&dir, 0, 5, &super::repo::LogFilter::None).expect("log");
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

    let log = super::repo::log(&dir, 0, 10, &super::repo::LogFilter::None).expect("log final");
    assert!(log.iter().any(|c| c.subject == "cambio en feature"), "el commit rebasado debe seguir en el historial");
    let content = std::fs::read_to_string(dir.join("f.txt")).unwrap();
    assert_eq!(content, "base\nmaster\nfeature\n");
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

    let log = super::repo::log(root, 0, 10, &super::repo::LogFilter::None).expect("log");
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

#[test]
fn refs_se_limpian_los_prefijos() {
    use super::repo::parse_refs_for_test as parse_refs;
    let r = parse_refs("HEAD -> master, origin/master, tag: v1.0");
    assert_eq!(r, vec!["master", "origin/master", "v1.0"]);
}

#[test]
fn refs_head_desprendido_se_descarta() {
    use super::repo::parse_refs_for_test as parse_refs;
    // Con HEAD desprendido, %D da "HEAD" suelto (sin "HEAD -> "): ya se
    // muestra aparte en la topbar, no debe salir como chip duplicado.
    let r = parse_refs("HEAD, tag: v1.0");
    assert_eq!(r, vec!["v1.0"]);
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
