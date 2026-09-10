use serde::Serialize;

/// Errores de la capa Git. Se serializan a un objeto `{ kind, message }`
/// que el frontend puede discriminar.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("no se encontró el ejecutable `git` en el PATH")]
    GitNotFound,

    #[error("la ruta no es un repositorio Git: {0}")]
    NotARepo(String),

    #[error("git falló ({code}): {stderr}")]
    CommandFailed { code: i32, stderr: String },

    #[error("no se pudo leer la salida de git: {0}")]
    Io(String),

    #[error("salida de git con formato inesperado: {0}")]
    Parse(String),
}

impl Serialize for GitError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let kind = match self {
            GitError::GitNotFound => "git_not_found",
            GitError::NotARepo(_) => "not_a_repo",
            GitError::CommandFailed { .. } => "command_failed",
            GitError::Io(_) => "io",
            GitError::Parse(_) => "parse",
        };
        let mut s = serializer.serialize_struct("GitError", 2)?;
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type GitResult<T> = Result<T, GitError>;
