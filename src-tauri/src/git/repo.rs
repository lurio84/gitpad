use std::path::Path;

use serde::Serialize;

use super::error::{GitError, GitResult};
use super::runner::run_git;

// Separadores usados en el formato de `git log`. Unit Separator entre campos.
const FS: char = '\u{1f}';

#[derive(Debug, Serialize)]
pub struct RepoInfo {
    /// Ruta absoluta a la raíz del repositorio (toplevel).
    pub root: String,
    /// Nombre de la rama activa, o `None` si HEAD está detached.
    pub head: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Fecha de autoría en ISO 8601 estricto.
    pub date: String,
    pub subject: String,
    /// Nombres de refs que apuntan a este commit (ramas, tags, HEAD).
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct StatusEntry {
    pub path: String,
    /// Ruta original, solo en renombrados/copias.
    pub orig_path: Option<String>,
    /// Estado en el índice (staged): M A D R C o "." si sin cambios.
    pub staged: String,
    /// Estado en el árbol de trabajo (unstaged).
    pub unstaged: String,
    /// "changed" | "renamed" | "unmerged" | "untracked" | "ignored"
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct Status {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub entries: Vec<StatusEntry>,
}

pub fn open(path: &Path) -> GitResult<RepoInfo> {
    let root = super::runner::resolve_repo_root(path)?;
    let head_raw = run_git(Path::new(&root), &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let head = match head_raw {
        Ok(name) => Some(name.trim().to_string()),
        // symbolic-ref sale con código != 0 cuando HEAD está detached.
        Err(GitError::CommandFailed { .. }) => None,
        Err(e) => return Err(e),
    };
    Ok(RepoInfo { root, head })
}

pub fn log(repo: &Path, skip: u32, count: u32) -> GitResult<Vec<Commit>> {
    let fmt = format!(
        "--pretty=format:%H{FS}%h{FS}%P{FS}%an{FS}%ae{FS}%aI{FS}%s{FS}%D"
    );
    let skip_arg = format!("--skip={skip}");
    let count_arg = format!("--max-count={count}");
    let out = run_git(
        repo,
        &["log", "--date-order", "-z", &fmt, &skip_arg, &count_arg],
    )?;

    let mut commits = Vec::new();
    for record in out.split('\0') {
        if record.is_empty() {
            continue;
        }
        let f: Vec<&str> = record.split(FS).collect();
        if f.len() != 8 {
            return Err(GitError::Parse(format!(
                "esperados 8 campos por commit, encontrados {}",
                f.len()
            )));
        }
        let parents = if f[2].trim().is_empty() {
            Vec::new()
        } else {
            f[2].split_whitespace().map(String::from).collect()
        };
        commits.push(Commit {
            hash: f[0].to_string(),
            short_hash: f[1].to_string(),
            parents,
            author_name: f[3].to_string(),
            author_email: f[4].to_string(),
            date: f[5].to_string(),
            subject: f[6].to_string(),
            refs: parse_refs(f[7]),
        });
    }
    Ok(commits)
}

/// `%D` produce algo como "HEAD -> master, origin/master, tag: v1.0".
fn parse_refs(raw: &str) -> Vec<String> {
    raw.split(", ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.strip_prefix("HEAD -> ")
                .or_else(|| s.strip_prefix("tag: "))
                .unwrap_or(s)
                .to_string()
        })
        .collect()
}

pub fn status(repo: &Path) -> GitResult<Status> {
    let out = run_git(repo, &["status", "--porcelain=v2", "-z", "--branch"])?;
    let tokens: Vec<String> = out
        .split('\0')
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect();
    parse_status_tokens(tokens)
}

fn parse_status_tokens(tokens: Vec<String>) -> GitResult<Status> {
    let tokens: Vec<&str> = tokens.iter().map(String::as_str).collect();

    let mut status = Status {
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        entries: Vec::new(),
    };

    let mut i = 0;
    while i < tokens.len() {
        let line = tokens[i];
        if let Some(rest) = line.strip_prefix("# ") {
            parse_branch_header(rest, &mut status);
            i += 1;
        } else if let Some(rest) = line.strip_prefix("1 ") {
            status.entries.push(parse_ordinary(rest, None)?);
            i += 1;
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // Los registros de renombrado/copia llevan la ruta original en el
            // SIGUIENTE token separado por NUL: hay que consumirlo aquí. Si falta
            // (salida truncada), es un error: sin él parse_ordinary tomaría el
            // score como ruta en silencio.
            let orig = tokens.get(i + 1).copied().map(String::from).ok_or_else(|| {
                GitError::Parse("registro de renombrado sin ruta original".into())
            })?;
            status.entries.push(parse_ordinary(rest, Some(orig))?);
            i += 2;
        } else if let Some(rest) = line.strip_prefix("u ") {
            status.entries.push(parse_unmerged(rest)?);
            i += 1;
        } else if let Some(rest) = line.strip_prefix("? ") {
            status.entries.push(StatusEntry {
                path: rest.to_string(),
                orig_path: None,
                staged: ".".into(),
                unstaged: "?".into(),
                kind: "untracked".into(),
            });
            i += 1;
        } else if let Some(rest) = line.strip_prefix("! ") {
            status.entries.push(StatusEntry {
                path: rest.to_string(),
                orig_path: None,
                staged: ".".into(),
                unstaged: "!".into(),
                kind: "ignored".into(),
            });
            i += 1;
        } else {
            return Err(GitError::Parse(format!("línea de status no reconocida: {line}")));
        }
    }
    Ok(status)
}

fn parse_branch_header(rest: &str, status: &mut Status) {
    if let Some(v) = rest.strip_prefix("branch.head ") {
        if v != "(detached)" {
            status.branch = Some(v.to_string());
        }
    } else if let Some(v) = rest.strip_prefix("branch.upstream ") {
        status.upstream = Some(v.to_string());
    } else if let Some(v) = rest.strip_prefix("branch.ab ") {
        // formato: "+N -M"
        for part in v.split_whitespace() {
            if let Some(n) = part.strip_prefix('+') {
                status.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix('-') {
                status.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

/// Registros `1` y `2`: "<XY> <sub> <mH> <mI> <mW> <hH> <hI> [<score> ]<path>".
/// Para `2` hay un campo extra (score de rename) antes de la ruta.
fn parse_ordinary(rest: &str, orig_path: Option<String>) -> GitResult<StatusEntry> {
    // splitn(8): tras saltar XY + 6 campos, el token 7 es el resto sin partir.
    // Para `1` es la ruta; para `2` es "<score> <ruta>" (la ruta puede llevar espacios).
    let mut parts = rest.splitn(8, ' ');
    let xy = parts
        .next()
        .ok_or_else(|| GitError::Parse("registro de status sin campo XY".into()))?;
    // Saltar sub, mH, mI, mW, hH, hI (6 campos).
    for _ in 0..6 {
        parts.next();
    }
    let is_rename = orig_path.is_some();
    let tail = parts
        .next()
        .ok_or_else(|| GitError::Parse("registro de status sin ruta".into()))?;
    let path = if is_rename {
        // tail = "<score> <path>"
        tail.splitn(2, ' ')
            .nth(1)
            .unwrap_or(tail)
            .to_string()
    } else {
        tail.to_string()
    };

    let (x, y) = split_xy(xy)?;
    Ok(StatusEntry {
        path,
        orig_path,
        staged: x.to_string(),
        unstaged: y.to_string(),
        kind: if is_rename { "renamed".into() } else { "changed".into() },
    })
}

fn parse_unmerged(rest: &str) -> GitResult<StatusEntry> {
    // Formato `u`: "<XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>".
    // 9 campos antes de la ruta (XY incluido); splitn(10) deja la ruta entera.
    let mut parts = rest.splitn(10, ' ');
    let xy = parts
        .next()
        .ok_or_else(|| GitError::Parse("registro unmerged sin campo XY".into()))?;
    for _ in 0..8 {
        parts.next();
    }
    let path = parts
        .next()
        .ok_or_else(|| GitError::Parse("registro unmerged sin ruta".into()))?
        .to_string();
    let (x, y) = split_xy(xy)?;
    Ok(StatusEntry {
        path,
        orig_path: None,
        staged: x.to_string(),
        unstaged: y.to_string(),
        kind: "unmerged".into(),
    })
}

fn split_xy(xy: &str) -> GitResult<(char, char)> {
    let mut chars = xy.chars();
    match (chars.next(), chars.next()) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => Err(GitError::Parse(format!("campo XY inválido: {xy}"))),
    }
}

#[cfg(test)]
pub(super) fn parse_status_tokens_for_test(tokens: Vec<String>) -> GitResult<Status> {
    parse_status_tokens(tokens)
}

#[cfg(test)]
pub(super) fn parse_refs_for_test(raw: &str) -> Vec<String> {
    parse_refs(raw)
}
