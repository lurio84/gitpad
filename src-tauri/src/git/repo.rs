use std::path::Path;

use serde::Serialize;

use super::error::{GitError, GitResult};
use super::runner::{run_git, run_git_bytes, run_git_stdin};

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

#[derive(Debug, Serialize)]
pub struct Branch {
    /// Nombre a mostrar: `"master"` para una rama local, `"origin/master"`
    /// para una remota.
    pub name: String,
    /// Lo que se le pasa a `git checkout`. Para una remota es el nombre SIN
    /// el prefijo del remoto (`"master"`, no `"origin/master"`): así git
    /// aplica el DWIM (crea la rama local con tracking) si no hay ya una
    /// local con ese nombre. Pasar la forma con el remoto, o el refname
    /// completo, deja HEAD "detached" en vez de cambiar de rama — comprobado
    /// contra git 2.55.
    pub checkout_arg: String,
    pub upstream: Option<String>,
    /// Ruta del worktree que tiene esta rama abierta ahora mismo, si no es
    /// este. `None` si la rama no está en ningún worktree o si es la de aquí.
    pub worktree_path: Option<String>,
    pub is_head: bool,
    pub is_remote: bool,
}

/// Qué filtrar en `log`. `--all` en los dos casos con filtro: buscar solo en
/// la rama activa no es lo que se espera de "buscar un commit".
pub enum LogFilter {
    None,
    /// Mensaje del commit. `-F` (literal, no regex) + `-i` (sin distinguir
    /// mayúsculas): sin ellas un `.` o un `*` en la búsqueda dan resultados
    /// que no tienen sentido para quien no espera regex.
    Message(String),
    /// Contenido añadido/quitado (`git log -S`).
    Content(String),
}

pub fn open(path: &Path) -> GitResult<RepoInfo> {
    let root = super::runner::resolve_repo_root(path)?;
    let head_raw = run_git(Path::new(&root), &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let head = match head_raw {
        Ok(name) => Some(name.trim().to_string()),
        // `symbolic-ref --quiet` sale con código 1 exactamente cuando HEAD está
        // detached; cualquier otro código es un fallo real.
        Err(GitError::CommandFailed { code: 1, .. }) => None,
        Err(e) => return Err(e),
    };
    Ok(RepoInfo { root, head })
}

pub fn log(repo: &Path, skip: u32, count: u32, filter: &LogFilter) -> GitResult<Vec<Commit>> {
    // Un repo recién iniciado (o una rama huérfana) no tiene commits en HEAD y
    // `git log` sale con código 128. Se detecta antes con `rev-parse --verify HEAD`
    // (código 1 si no hay commit) y se devuelve una lista vacía en vez de un error.
    if run_git(repo, &["rev-parse", "--quiet", "--verify", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }

    let fmt = format!(
        "--pretty=format:%H{FS}%h{FS}%P{FS}%an{FS}%ae{FS}%aI{FS}%s{FS}%D"
    );
    let skip_arg = format!("--skip={skip}");
    let count_arg = format!("--max-count={count}");
    let mut args = vec![
        "log".to_string(),
        "--date-order".to_string(),
        "--decorate=short".to_string(),
        "-z".to_string(),
        fmt,
    ];
    // Formas pegadas (`--grep=`, `-S<q>`): una búsqueda que empiece por `-`
    // no se lee como opción de git.
    match filter {
        LogFilter::None => {}
        LogFilter::Message(q) => {
            args.push("--all".to_string());
            args.push("-i".to_string());
            args.push("-F".to_string());
            args.push(format!("--grep={q}"));
        }
        LogFilter::Content(q) => {
            args.push("--all".to_string());
            args.push(format!("-S{q}"));
        }
    }
    args.push(skip_arg);
    args.push(count_arg);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_git(repo, &args)?;

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

/// `%D` produce algo como "HEAD -> master, origin/master, tag: v1.0", o
/// "HEAD, tag: v1.0" con HEAD desprendido — ahí "HEAD" va suelto, sin
/// prefijo que quitar. Se descarta: ya se muestra aparte en la topbar.
fn parse_refs(raw: &str) -> Vec<String> {
    raw.split(", ")
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "HEAD")
        .map(|s| {
            s.strip_prefix("HEAD -> ")
                .or_else(|| s.strip_prefix("tag: "))
                .unwrap_or(s)
                .to_string()
        })
        .collect()
}

pub fn status(repo: &Path) -> GitResult<Status> {
    // UTF-8 estricto (no lossy): esta ruta alimenta `git add`, así que un byte
    // no válido debe romper la vista de status con un error legible en vez de
    // corromper una ruta en silencio y arriesgarse a prepararla mal.
    let bytes = run_git_bytes(
        repo,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=normal",
        ],
    )?;
    let out = String::from_utf8(bytes)
        .map_err(|_| GitError::Parse("la salida de git status tiene bytes no UTF-8".into()))?;
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
            .ok_or_else(|| {
                GitError::Parse("registro de renombrado sin score y ruta".into())
            })?
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

/// Diff completo de un commit (contra su primer padre; contra el árbol vacío si
/// es raíz). Devuelve el texto unificado tal cual, sin la cabecera del commit.
/// Los commits de merge dan salida vacía (git no muestra combined diff por
/// defecto) — aceptable para v0.
pub fn commit_diff(repo: &Path, hash: &str) -> GitResult<String> {
    if hash.is_empty() || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::Parse(format!("hash de commit inválido: {hash}")));
    }
    run_git(
        repo,
        &["show", "--format=", "--no-color", "--no-ext-diff", "-U3", hash],
    )
}

/// Diff de un archivo en el árbol de trabajo. `staged` elige entre el diff del
/// índice contra HEAD (`--cached`) y el del árbol de trabajo contra el índice.
/// La ruta va tras `--` para que un nombre que empiece por `-` no se lea como
/// opción, y se pasa exactamente como la dio `status`.
pub fn file_diff(repo: &Path, file: &str, staged: bool) -> GitResult<String> {
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-U3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(file);
    run_git(repo, &args)
}

/// Prepara rutas en el índice (`git add`). Las rutas van tras `--` y tal cual
/// las dio `status`.
pub fn stage(repo: &Path, paths: &[String]) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(repo, &args).map(|_| ())
}

/// Saca rutas del índice. `git reset -- <ruta>` en vez de `restore --staged`
/// porque el primero también funciona en un repo sin HEAD todavía.
pub fn unstage(repo: &Path, paths: &[String]) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["reset", "--quiet", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(repo, &args).map(|_| ())
}

/// Crea un commit con lo que haya en el índice. El mensaje va por stdin
/// (`-F -`). `amend` reescribe el último commit.
pub fn commit(repo: &Path, message: &str, amend: bool) -> GitResult<String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err(GitError::Parse("el mensaje de commit está vacío".into()));
    }
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    run_git_stdin(repo, &args, msg)
}

/// Ramas locales y remotas, más recientes primero. `%(worktreepath)` viene
/// vacío salvo que la rama esté abierta en un worktree (comprobado en vivo,
/// git 2.55): con eso se puede marcar como bloqueada *antes* del clic, en vez
/// de traducir después el error de `checkout`.
pub fn branches(repo: &Path) -> GitResult<Vec<Branch>> {
    let fmt = format!("%(refname){FS}%(upstream:short){FS}%(worktreepath){FS}%(HEAD)");
    let out = run_git(
        repo,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={fmt}"),
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    parse_branch_lines(&out)
}

fn parse_branch_lines(raw: &str) -> GitResult<Vec<Branch>> {
    let mut branches = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(FS).collect();
        if f.len() != 4 {
            return Err(GitError::Parse(format!(
                "esperados 4 campos por rama, encontrados {}",
                f.len()
            )));
        }
        let full = f[0];
        // `refname:short` no vale aquí: cuando una rama y un tag comparten
        // nombre, git lo desambigua como "heads/<nombre>", y pasar esa forma
        // (o el refname completo) a `checkout` deja HEAD "detached" en vez de
        // cambiar de rama — comprobado en vivo. Se quita el prefijo a mano.
        let (is_remote, name) = if let Some(r) = full.strip_prefix("refs/heads/") {
            (false, r.to_string())
        } else if let Some(r) = full.strip_prefix("refs/remotes/") {
            (true, r.to_string())
        } else {
            continue; // ref inesperada (no debería salir de refs/heads o refs/remotes)
        };
        // `origin/HEAD`: puntero simbólico al HEAD del remoto, no una rama.
        if is_remote && name.rsplit('/').next() == Some("HEAD") {
            continue;
        }
        let checkout_arg = if is_remote {
            // Quitar "<remoto>/" para que `git checkout <rama>` dispare el
            // DWIM (crea la rama local con tracking) en vez de resolver el
            // nombre con el remoto como un checkout "detached" directo.
            name.splitn(2, '/').nth(1).unwrap_or(&name).to_string()
        } else {
            name.clone()
        };
        branches.push(Branch {
            name,
            checkout_arg,
            upstream: (!f[1].is_empty()).then(|| f[1].to_string()),
            worktree_path: (!f[2].is_empty()).then(|| f[2].to_string()),
            is_head: f[3] == "*",
            is_remote,
        });
    }
    Ok(branches)
}

/// Cambia de rama. `name` debe ser el nombre corto sin cualificar
/// (`checkout_arg` de `Branch`, o el nombre tal cual de una rama local):
/// es la única forma que hace que `git checkout` cambie de rama en vez de
/// dejar HEAD "detached".
pub fn checkout(repo: &Path, name: &str) -> GitResult<()> {
    run_git(repo, &["checkout", name]).map(|_| ())
}

#[cfg(test)]
pub(super) fn parse_status_tokens_for_test(tokens: Vec<String>) -> GitResult<Status> {
    parse_status_tokens(tokens)
}

#[cfg(test)]
pub(super) fn parse_branch_lines_for_test(raw: &str) -> GitResult<Vec<Branch>> {
    parse_branch_lines(raw)
}

#[cfg(test)]
pub(super) fn parse_refs_for_test(raw: &str) -> Vec<String> {
    parse_refs(raw)
}
