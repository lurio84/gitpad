import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Commit, RepoInfo, Status } from "./types";

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
): Promise<Commit[]> {
  return invoke("get_log", { path, skip, count });
}

export function getStatus(path: string): Promise<Status> {
  return invoke("get_status", { path });
}
