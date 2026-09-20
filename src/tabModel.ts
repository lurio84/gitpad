import type { LogFilterMode } from "./api";
import type {
  Branch,
  Commit,
  CommitFile,
  FileContent,
  OpState,
  RepoInfo,
  Stash,
  Status,
} from "./types";

export const LOG_PAGE = 200;

/** Cómo se pide el log de una pestaña. Vive en un `ref` (ver `filters`) porque
 * `reload` es estable y no puede leer `tabs` por closure. */
export interface LogView {
  mode: LogFilterMode;
  query: string;
  branch: string | null;
  /** Historial de un archivo: lente pasajero, exclusivo con la búsqueda. */
  file: string | null;
  limit: number;
}
export const DEFAULT_VIEW: LogView = {
  mode: "message",
  query: "",
  branch: null,
  file: null,
  limit: LOG_PAGE,
};

const TABS_KEY = "gitpad:tabs";
export const ACTIVE_KEY = "gitpad:active";
const LEGACY_REPO_KEY = "gitpad:last-repo";

/** Qué se está mirando en el panel de diff de una pestaña. */
export type Selection =
  | {
      t: "commit";
      hash: string;
      isMerge?: boolean;
      file?: string;
      origPath?: string;
      /** `content` = el archivo entero en ese commit (explorador «Todos los
       * archivos»); sin marca, su diff. Cuenta para `sameSelection`: si no,
       * el diff que llega tarde pisaría al visor del mismo archivo. */
      view?: "content";
    }
  | { t: "file"; path: string; staged: boolean; untracked?: boolean };

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.t === "commit" && b.t === "commit")
    return a.hash === b.hash && a.file === b.file && a.view === b.view;
  if (a.t === "file" && b.t === "file")
    return a.path === b.path && a.staged === b.staged;
  return false;
}

/** Estado de una pestaña. La clave es `root` (toplevel resuelto del repo). */
export interface Tab {
  root: string;
  info: RepoInfo | null;
  commits: Commit[];
  branches: Branch[];
  status: Status | null;
  sel: Selection | null;
  diff: string | null;
  diffLoading: boolean;
  /** Archivos del commit seleccionado (vacío si es un merge o no hay commit). */
  commitFiles: CommitFile[];
  commitFilesLoading: boolean;
  /** Qué lista muestra el panel derecho: los cambios (de un commit o del árbol
   * de trabajo) o todos los archivos del proyecto en ese commit. */
  filesScope: "changes" | "all";
  /** Árbol completo del commit `treeHash` (`null` = aún sin pedir). */
  treePaths: string[];
  /** Rutas reales del commit: mayor que `treePaths.length` si se recortó. */
  treeTotal: number;
  treeHash: string | null;
  treeLoading: boolean;
  content: FileContent | null;
  contentLoading: boolean;
  commitSubject: string;
  commitBody: string;
  amend: boolean;
  /** Lo escrito antes de marcar amend, para restaurarlo al desmarcar. */
  amendDraft: { subject: string; body: string } | null;
  committing: boolean;
  /** Qué operación de red está en curso, o `null` si ninguna. */
  remoting: "fetch" | "pull" | "push" | null;
  /** Rebase/cherry-pick/merge parado a medias por un conflicto, o `null`. */
  opState: OpState | null;
  /** `true` mientras se ejecuta Continuar/Abortar sobre `opState`. */
  opBusy: boolean;
  stashes: Stash[];
  stashMsg: string;
  stashIncludeUntracked: boolean;
  stashBusy: boolean;
  cherryBusy: boolean;
  /** Rama base elegida para el rebase; se precarga con `default_base`. */
  rebaseTarget: string;
  rebasing: boolean;
  /** `true` mientras se ejecuta una operación sobre ramas/tags (merge, …). */
  refBusy: boolean;
  filterMode: LogFilterMode;
  filterQuery: string;
  /** Ref completa (`refs/heads/x`) si el log se limita a una rama; null = todas. */
  filterBranch: string | null;
  /** Ruta si el log muestra solo el historial de ese archivo; null = normal. */
  filterFile: string | null;
  /** Cuántos commits se pidieron al log (crece de LOG_PAGE en LOG_PAGE). */
  logLimit: number;
  error: string | null;
  loading: boolean;
}

export function emptyTab(root: string): Tab {
  return {
    root,
    info: null,
    commits: [],
    branches: [],
    status: null,
    sel: null,
    diff: null,
    diffLoading: false,
    commitFiles: [],
    commitFilesLoading: false,
    filesScope: "changes",
    treePaths: [],
    treeTotal: 0,
    treeHash: null,
    treeLoading: false,
    content: null,
    contentLoading: false,
    commitSubject: "",
    commitBody: "",
    amend: false,
    amendDraft: null,
    committing: false,
    remoting: null,
    opState: null,
    opBusy: false,
    stashes: [],
    stashMsg: "",
    stashIncludeUntracked: true,
    stashBusy: false,
    cherryBusy: false,
    rebaseTarget: "",
    rebasing: false,
    refBusy: false,
    filterMode: "message",
    filterQuery: "",
    filterBranch: null,
    filterFile: null,
    logLimit: LOG_PAGE,
    error: null,
    loading: true,
  };
}

export function persistTabs(tabs: Tab[]): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map((t) => t.root)));
  } catch {
    /* localStorage lleno o bloqueado: no es crítico */
  }
}

export function persistActive(root: string | null): void {
  try {
    if (root) localStorage.setItem(ACTIVE_KEY, root);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* idem */
  }
}

/** Lee la lista de repos a restaurar, migrando la clave antigua de un solo repo. */
export function restoreRoots(): string[] {
  let roots: string[] = [];
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) roots = parsed.filter((r) => typeof r === "string");
    }
  } catch {
    /* JSON corrupto: se empieza con lista vacía */
  }
  const legacy = localStorage.getItem(LEGACY_REPO_KEY);
  if (legacy && !roots.includes(legacy)) roots.push(legacy);
  localStorage.removeItem(LEGACY_REPO_KEY);
  return roots;
}
