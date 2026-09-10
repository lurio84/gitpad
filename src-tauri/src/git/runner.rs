use std::path::Path;
use std::process::Command;

use super::error::{GitError, GitResult};

/// Ejecuta `git -C <repo> <args...>` de forma bloqueante y devuelve stdout como bytes.
///
/// `GIT_TERMINAL_PROMPT=0` fuerza que cualquier petición de credenciales falle en vez
/// de bloquear el proceso esperando una entrada que nunca llega (no hay TTY). Así un
/// problema de auth aparece como `CommandFailed` y no como un cuelgue invisible.
pub fn run_git_bytes(repo: &Path, args: &[&str]) -> GitResult<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GitError::GitNotFound
            } else {
                GitError::Io(e.to_string())
            }
        })?;

    if !output.status.success() {
        return Err(GitError::CommandFailed {
            code: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    Ok(output.stdout)
}

/// Igual que `run_git_bytes` pero decodifica stdout como UTF-8 (lossy).
pub fn run_git(repo: &Path, args: &[&str]) -> GitResult<String> {
    let bytes = run_git_bytes(repo, args)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Comprueba que `path` está dentro de un árbol de trabajo Git y devuelve la raíz
/// del repositorio (toplevel).
pub fn resolve_repo_root(path: &Path) -> GitResult<String> {
    if !path.exists() {
        return Err(GitError::NotARepo(path.display().to_string()));
    }
    match run_git(path, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => Ok(root.trim().to_string()),
        Err(GitError::CommandFailed { .. }) => {
            Err(GitError::NotARepo(path.display().to_string()))
        }
        Err(e) => Err(e),
    }
}
