import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  Branch,
  Commit,
  CommitFile,
  FileContent,
  TreeFiles,
  OpState,
  RepoInfo,
  Stash,
  Status,
  Tag,
} from "./types";

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
  filterBranch: string | null = null,
  /** Historial de UN archivo (ruta relativa); manda sobre `filterMode`/`filterQuery`. */
  filterFile: string | null = null,
): Promise<Commit[]> {
  return invoke("get_log", {
    path,
    skip,
    count,
    filterMode,
    filterQuery,
    filterBranch,
    filterFile,
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

/** Todas las rutas del árbol de un commit, recursivo (no solo las que tocó). */
export function getTreeFiles(path: string, hash: string): Promise<TreeFiles> {
  return invoke("get_tree_files", { path, hash });
}

export function getFileContent(
  path: string,
  hash: string,
  file: string,
): Promise<FileContent> {
  return invoke("get_file_content", { path, hash, file });
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

/** Trae una rama LOCAL que no es la activa, sin checkout. `remote`/`remoteRef`
 * salen de `Branch.upstream_remote`/`upstream_ref` — nunca se reconstruyen a
 * mano (una rama puede trackear una remota de otro nombre). Solo avanza si
 * es fast-forward: si no, o si la rama resulta bloqueada, el error lo decide
 * git, no un texto adivinado. */
export function fetchBranch(path: string, branch: string, remote: string, remoteRef: string): Promise<void> {
  return invoke("fetch_branch", { path, branch, remote, remoteRef });
}

/** Envía una rama LOCAL que no es la activa a su upstream ya configurado. */
export function pushBranch(path: string, branch: string, remote: string, remoteRef: string): Promise<void> {
  return invoke("push_branch", { path, branch, remote, remoteRef });
}

/** Igual, para una rama LOCAL sin upstream: push -u contra el primer remoto. */
export function pushNewBranch(path: string, branch: string): Promise<void> {
  return invoke("push_new_branch", { path, branch });
}

/** Sube un tag YA EXISTENTE al remoto (primer remoto configurado). */
export function pushTagRemote(path: string, name: string): Promise<void> {
  return invoke("push_tag_remote", { path, name });
}

/** Borra un tag del remoto. No exige que exista local. */
export function deleteRemoteTag(path: string, name: string): Promise<void> {
  return invoke("delete_remote_tag", { path, name });
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

/** `from` va cualificada: `refs/heads/x` o `refs/remotes/o/x`. */
export function mergeBranch(path: string, from: string): Promise<void> {
  return invoke("merge_branch", { path, from });
}

/** Commit nuevo que deshace `hash`. Un conflicto deja un revert en curso (`opState`). */
export function revertCommit(path: string, hash: string): Promise<void> {
  return invoke("revert_commit", { path, hash });
}

export type ResetMode = "soft" | "mixed" | "hard";

/** Mueve la rama actual a `hash`. `hard` descarta los cambios sin guardar. */
export function resetTo(path: string, hash: string, mode: ResetMode): Promise<void> {
  return invoke("reset_to", { path, hash, mode });
}

/** Crea la rama y cambia a ella. `at`: hash de partida; sin él, HEAD. */
export function createBranch(path: string, name: string, at?: string): Promise<void> {
  return invoke("create_branch", { path, name, at: at ?? null });
}

export function renameBranch(path: string, old: string, newName: string): Promise<void> {
  return invoke("rename_branch", { path, old, new: newName });
}

/** Sin `force`, falla con `not_merged` si la rama tiene commits fuera de HEAD. */
export function deleteBranch(path: string, name: string, force: boolean): Promise<void> {
  return invoke("delete_branch", { path, name, force });
}

/** Tag ligero y local. `at`: hash; sin él, HEAD. */
export function createTag(path: string, name: string, at?: string): Promise<void> {
  return invoke("create_tag", { path, name, at: at ?? null });
}

export function deleteTag(path: string, name: string): Promise<void> {
  return invoke("delete_tag", { path, name });
}

export function getTags(path: string): Promise<Tag[]> {
  return invoke("get_tags", { path });
}

export function getDefaultBase(path: string): Promise<string | null> {
  return invoke("get_default_base", { path });
}
