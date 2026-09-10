use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use super::error::{GitError, GitResult};

/// Ejecuta `git -C <repo> <args...>` de forma bloqueante y devuelve stdout como bytes.
///
/// `GIT_TERMINAL_PROMPT=0` fuerza que cualquier petición de credenciales falle en vez
/// de bloquear el proceso esperando una entrada que nunca llega (no hay TTY). Así un
/// problema de auth aparece como `CommandFailed` y no como un cuelgue invisible.
pub fn run_git_bytes(repo: &Path, args: &[&str]) -> GitResult<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");

    // En Windows, lanzar git.exe desde una app GUI (subsystem "windows") crea una
    // consola que parpadea en cada invocación. CREATE_NO_WINDOW la suprime.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
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

/// Como `run_git` pero escribe `input` en el stdin de git. Se usa para
/// `commit -F -`: pasar el mensaje por stdin evita que uno que empiece por `-`
/// o lleve saltos de línea se malinterprete como argumentos.
///
/// En un fallo con código 1 y stderr vacío (típico de "nothing to commit", que
/// git escribe en stdout) se adjunta el stdout como mensaje para que el
/// frontend muestre algo útil en vez de "git falló (1): ".
pub fn run_git_stdin(repo: &Path, args: &[&str], input: &str) -> GitResult<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GitError::GitNotFound
        } else {
            GitError::Io(e.to_string())
        }
    })?;

    child
        .stdin
        .take()
        .expect("stdin piped")
        .write_all(input.as_bytes())
        .map_err(|e| GitError::Io(e.to_string()))?;

    let output = child
        .wait_with_output()
        .map_err(|e| GitError::Io(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(GitError::CommandFailed {
            code: output.status.code().unwrap_or(-1),
            stderr: if stderr.is_empty() { stdout } else { stderr },
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
