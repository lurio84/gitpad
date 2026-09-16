// Espejo de las structs de `src-tauri/src/git/repo.rs`.

export interface RepoInfo {
  root: string;
  head: string | null;
}

export interface Commit {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  date: string;
  subject: string;
  refs: string[];
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
    | "parse";
  message: string;
}

export interface Branch {
  /** "master" para local, "origin/master" para remota. */
  name: string;
  /** Lo que se pasa a `checkoutBranch` (nunca `name` directamente). */
  checkout_arg: string;
  upstream: string | null;
  /** Ruta del worktree que la tiene abierta ahora, si no es esta. */
  worktree_path: string | null;
  is_head: boolean;
  is_remote: boolean;
}

/** Rebase/cherry-pick/merge parado a medias por un conflicto. */
export interface OpState {
  kind: "rebase" | "cherry_pick" | "merge";
}

/** Un archivo tocado por un commit (`git show --name-status`). */
export interface CommitFile {
  path: string;
  /** Ruta original, solo en renombrados. */
  orig_path: string | null;
  /** "A" | "M" | "D" | "R100" | ... tal cual lo da `--name-status`. */
  status: string;
}

export interface Stash {
  index: number;
  /** Tal cual lo da `git stash list` (incluye el prefijo "On <rama>: "). */
  message: string;
}
