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
