import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Branch, Commit, CommitFile, OpState, RepoInfo, Stash, Status } from "./types";

export type LogFilterMode = "none" | "message" | "content";

/** Abre el selector de carpetas del SO. `null` si el usuario cancela. */
export async function pickRepoFolder(): Promise<string | null> {
  const selected = await openDialog({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export function openRepo(path: string): Promise<RepoInfo> {
  return invoke("open_repo", { path });
}

export function getLog(
  path: string,
  skip: number,
  count: number,
  filterMode: LogFilterMode = "none",
  filterQuery = "",
): Promise<Commit[]> {
  return invoke("get_log", {
    path,
    skip,
    count,
    filterMode,
    filterQuery,
  });
}

export function getStatus(path: string): Promise<Status> {
  return invoke("get_status", { path });
}

export function getCommitDiff(path: string, hash: string): Promise<string> {
  return invoke("get_commit_diff", { path, hash });
}

export function getFileDiff(
  path: string,
  file: string,
  staged: boolean,
): Promise<string> {
  return invoke("get_file_diff", { path, file, staged });
}

export function getCommitFiles(path: string, hash: string): Promise<CommitFile[]> {
  return invoke("get_commit_files", { path, hash });
}

export function getCommitFileDiff(
  path: string,
  hash: string,
  file: string,
  origPath: string | null,
): Promise<string> {
  return invoke("get_commit_file_diff", { path, hash, file, origPath });
}

export function stagePaths(path: string, paths: string[]): Promise<void> {
  return invoke("stage_paths", { path, paths });
}

export function unstagePaths(path: string, paths: string[]): Promise<void> {
  return invoke("unstage_paths", { path, paths });
}

/** Irreversible: descarta cambios sin comprometer (`untracked` borra del
 * disco en vez de restaurar desde HEAD). `origPaths` son las rutas viejas de
 * los renombrados incluidos en `paths` (`StatusEntry.orig_path`) —
 * imprescindibles, o el archivo se pierde en vez de restaurarse. La UI debe
 * confirmar antes. */
export function discardPaths(
  path: string,
  paths: string[],
  origPaths: string[],
  untracked: boolean,
): Promise<void> {
  return invoke("discard_paths", { path, paths, origPaths, untracked });
}

export function commit(
  path: string,
  message: string,
  amend: boolean,
): Promise<string> {
  return invoke("commit", { path, message, amend });
}

export function getBranches(path: string): Promise<Branch[]> {
  return invoke("get_branches", { path });
}

/** `name` debe ser `checkout_arg` de la rama, nunca `name`. */
export function checkoutBranch(path: string, name: string): Promise<void> {
  return invoke("checkout_branch", { path, name });
}

export function fetchRemote(path: string): Promise<void> {
  return invoke("fetch_remote", { path });
}

export function pullRemote(path: string): Promise<void> {
  return invoke("pull_remote", { path });
}

export function pushRemote(path: string): Promise<void> {
  return invoke("push_remote", { path });
}

export function getOpState(path: string): Promise<OpState | null> {
  return invoke("get_op_state", { path });
}

export function opContinue(path: string): Promise<void> {
  return invoke("op_continue", { path });
}

export function opAbort(path: string): Promise<void> {
  return invoke("op_abort", { path });
}

export function stashPush(
  path: string,
  message: string,
  includeUntracked: boolean,
): Promise<void> {
  return invoke("stash_push", { path, message, includeUntracked });
}

export function getStashes(path: string): Promise<Stash[]> {
  return invoke("get_stashes", { path });
}

export function stashApply(path: string, index: number, pop: boolean): Promise<void> {
  return invoke("stash_apply", { path, index, pop });
}

export function stashDrop(path: string, index: number): Promise<void> {
  return invoke("stash_drop", { path, index });
}

export function cherryPick(path: string, hash: string): Promise<void> {
  return invoke("cherry_pick", { path, hash });
}

export function rebaseOnto(path: string, onto: string): Promise<void> {
  return invoke("rebase_onto", { path, onto });
}

export function getDefaultBase(path: string): Promise<string | null> {
  return invoke("get_default_base", { path });
}
