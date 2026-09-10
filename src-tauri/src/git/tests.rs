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
