// Espejo de las structs de `src-tauri/src/git/repo.rs`.

export interface RepoInfo {
  root: string;
  head: string | null;
  /** Hash completo de HEAD, o `null` en un repo sin commits todavía. */
  head_hash: string | null;
}

/** Ref que decora un commit. `head` = la rama activa; `other` p. ej. `refs/stash`. */
export interface RefChip {
  name: string;
  kind: "head" | "local" | "remote" | "tag" | "other";
}

export interface Commit {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  date: string;
  subject: string;
  refs: RefChip[];
  body: string;
}

export type StatusKind =
  | "changed"
  | "renamed"
  | "unmerged"
  | "untracked"
  | "ignored";

export interface StatusEntry {
  path: string;
  orig_path: string | null;
  staged: string;
  unstaged: string;
  kind: StatusKind;
}

export interface Status {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
}

export interface GitError {
  kind:
    | "git_not_found"
    | "not_a_repo"
    | "command_failed"
    | "io"
    | "parse"
    | "not_merged";
  message: string;
}

export interface Branch {
  /** "master" para local, "origin/master" para remota. */
  name: string;
  /** Lo que se pasa a `checkoutBranch` (nunca `name` directamente). */
  checkout_arg: string;
  /** "origin/master", para mostrar. */
  upstream: string | null;
  /** Remoto del upstream ("origin"), separado del nombre de la rama remota:
   * una local puede trackear una remota de OTRO nombre. */
  upstream_remote: string | null;
  /** Ref completa del upstream ("refs/heads/bar"): lo que hace falta para
   * fetch/push con refspec explícito sobre una rama que no es la activa. */
  upstream_ref: string | null;
  /** Ruta del worktree que la tiene abierta ahora, si no es esta. */
  worktree_path: string | null;
  is_head: boolean;
  is_remote: boolean;
}

export interface Tag {
  /** Nombre corto, sin `refs/tags/`. */
  name: string;
  /** Commit al que apunta (ya resuelto: tag anotado o ligero). */
  target: string;
}

/** Rebase/cherry-pick/merge parado a medias por un conflicto. */
export interface OpState {
  kind: "rebase" | "cherry_pick" | "merge" | "revert";
}

/** Un archivo tocado por un commit (`git show --name-status`). */
export interface CommitFile {
  path: string;
  /** Ruta original, solo en renombrados. */
  orig_path: string | null;
  /** "A" | "M" | "D" | "R100" | ... tal cual lo da `--name-status`. */
  status: string;
}

/** Rutas del árbol de un commit. Con más de 50 000 llegan solo las primeras. */
export interface TreeFiles {
  paths: string[];
  /** `true` si `paths` es solo una parte de las `total` rutas del commit. */
  truncated: boolean;
  total: number;
}

/** Contenido de un archivo en un commit (`git show <hash>:<ruta>`). */
export interface FileContent {
  /** Texto del archivo, o `null` si es binario o demasiado grande para leerlo (>64 MiB). */
  text: string | null;
  binary: boolean;
  /** `true` si se recortó a 2 MiB (o, con `text: null`, si ni se leyó por su tamaño). */
  truncated: boolean;
  /** Tamaño real del blob completo, aunque `text` vaya recortado. */
  bytes: number;
}

export interface Stash {
  index: number;
  /** Tal cual lo da `git stash list` (incluye el prefijo "On <rama>: "). */
  message: string;
}
