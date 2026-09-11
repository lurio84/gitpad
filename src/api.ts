import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Branch, Commit, RepoInfo, Status } from "./types";

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

export function stagePaths(path: string, paths: string[]): Promise<void> {
  return invoke("stage_paths", { path, paths });
}

export function unstagePaths(path: string, paths: string[]): Promise<void> {
  return invoke("unstage_paths", { path, paths });
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
