import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkoutBranch,
  cherryPick,
  commit as commitRepo,
  createBranch,
  createTag,
  deleteBranch,
  deleteTag,
  discardPaths,
  fetchRemote,
  getBranches,
  getCommitDiff,
  getCommitFileDiff,
  getCommitFiles,
  getDefaultBase,
  getFileContent,
  getFileDiff,
  getLog,
  getOpState,
  getStashes,
  getStatus,
  getTreeFiles,
  opAbort,
  opContinue,
  mergeBranch,
  openRepo,
  pickRepoFolder,
  pullRemote,
  pushRemote,
  rebaseOnto,
  renameBranch,
  stagePaths,
  stashApply,
  stashDrop,
  stashPush,
  unstagePaths,
  type LogFilterMode,
} from "./api";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { DiffView } from "./Diff";
import { FilesViewToggle, FileTree, leafIndent, useFilesView } from "./FileTree";
import { FileView } from "./FileView";
import { Graph, ROW_H, WIP_HASH } from "./Graph";
import { usePanels } from "./usePanels";
import type {
  Branch,
  Commit,
  CommitFile,
  FileContent,
  GitError,
  OpState,
  RepoInfo,
  Stash,
  Status,
} from "./types";
import "./App.css";

const LOG_PAGE = 200;

/** Cómo se pide el log de una pestaña. Vive en un `ref` (ver `filters`) porque
 * `reload` es estable y no puede leer `tabs` por closure. */
interface LogView {
  mode: LogFilterMode;
  query: string;
  branch: string | null;
  limit: number;
}
const DEFAULT_VIEW: LogView = { mode: "message", query: "", branch: null, limit: LOG_PAGE };

/** Ref completa que se le pasa a `get_log` para ver solo una rama. */
const branchRef = (b: Branch) => (b.is_remote ? "refs/remotes/" : "refs/heads/") + b.name;
const branchLabel = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

/** Clase de un botón con una operación en curso: el CSS dibuja un spinner encima
 * y deja la etiqueta (invisible) donde está, así el botón no cambia de ancho ni
 * desplaza a los de al lado. */
const busyClass = (busy: boolean): string | undefined => (busy ? "busy" : undefined);

/** "19 sep" el mismo año, "19 sep 2025" otro año. El detalle completo va en el
 * `title`: en la columna de commits, que es estrecha, la fecha larga se partía. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}
const TABS_KEY = "gitpad:tabs";
const ACTIVE_KEY = "gitpad:active";
const LEGACY_REPO_KEY = "gitpad:last-repo";

/** Qué se está mirando en el panel de diff de una pestaña. */
type Selection =
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

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.t === "commit" && b.t === "commit")
    return a.hash === b.hash && a.file === b.file && a.view === b.view;
  if (a.t === "file" && b.t === "file")
    return a.path === b.path && a.staged === b.staged;
  return false;
}

/** Estado de una pestaña. La clave es `root` (toplevel resuelto del repo). */
interface Tab {
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
  /** Cuántos commits se pidieron al log (crece de LOG_PAGE en LOG_PAGE). */
  logLimit: number;
  error: string | null;
  loading: boolean;
}

function emptyTab(root: string): Tab {
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
    logLimit: LOG_PAGE,
    error: null,
    loading: true,
  };
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

/** Commit sintético para el nodo //WIP (equivalente al de GitKraken): se
 * antepone a la lista real solo para dibujar el grafo y la fila de la
 * lista, nunca se manda a un comando git. */
function wipCommit(parent: string): Commit {
  return {
    hash: WIP_HASH,
    short_hash: "",
    parents: [parent],
    author_name: "",
    author_email: "",
    date: "",
    subject: "//WIP",
    refs: [],
    body: "",
  };
}

function isGitError(e: unknown): e is GitError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

function persistTabs(tabs: Tab[]): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map((t) => t.root)));
  } catch {
    /* localStorage lleno o bloqueado: no es crítico */
  }
}

function persistActive(root: string | null): void {
  try {
    if (root) localStorage.setItem(ACTIVE_KEY, root);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* idem */
  }
}

/** Lee la lista de repos a restaurar, migrando la clave antigua de un solo repo. */
function restoreRoots(): string[] {
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

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [filesView, setFilesView] = useFilesView();
  const panels = usePanels();
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  // Trazado del grafo (momento firma): solo tras una acción del usuario (abrir
  // un repo, cambiar de pestaña) y en el arranque — nunca en un refresco.
  // `introPending` recuerda que toca; `introOn` es la clase que dura lo que la
  // animación (el timer va en el efecto, sin cleanup: si el efecto se relanza
  // por otra dependencia, no debe cortar el timer y dejar la clase puesta).
  const introPending = useRef(true);
  const [introOn, setIntroOn] = useState(false);
  // Abrir un repo resuelve su toplevel antes de crear la pestaña; ese hueco
  // corto no cuelga de ninguna pestaña, así que su estado va aparte.
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // Arrastre para reordenar pestañas: cuál se arrastra y sobre cuál está.
  const [dragRoot, setDragRoot] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Menú contextual abierto (clic derecho en una rama, un commit o un tag).
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Token de generación POR repo: una carga lenta de una pestaña no puede
  // descartar el resultado fresco de otra (ni el suyo propio si se recarga).
  const gens = useRef<Map<string, number>>(new Map());
  // Filtro de búsqueda aplicado POR repo. Vive en un ref (no en el estado de
  // la pestaña) porque `reload` es estable y no puede leer `tabs` por
  // closure; `reload` lee de aquí, y aplicar un filtro nuevo escribe aquí
  // antes de recargar.
  const filters = useRef<Map<string, LogView>>(new Map());

  const reload = useCallback(
    async (
      root: string,
      opts?: {
        dropOnError?: boolean;
        filter?: Partial<Omit<LogView, "limit">>;
      },
    ) => {
      // Un filtro nuevo vuelve a la primera página.
      if (opts?.filter) {
        filters.current.set(root, {
          ...(filters.current.get(root) ?? DEFAULT_VIEW),
          ...opts.filter,
          limit: LOG_PAGE,
        });
      }
      const filter = filters.current.get(root) ?? DEFAULT_VIEW;
      const gen = (gens.current.get(root) ?? 0) + 1;
      gens.current.set(root, gen);
      setTabs((ts) =>
        ts.map((t) => (t.root === root ? { ...t, loading: true, error: null } : t)),
      );
      try {
        const info = await openRepo(root);
        const [log, st, branches, opState, stashes, defaultBase] = await Promise.all([
          getLog(info.root, 0, filter.limit, filter.mode, filter.query, filter.branch),
          getStatus(info.root),
          getBranches(info.root),
          getOpState(info.root),
          getStashes(info.root),
          getDefaultBase(info.root),
        ]);
        if (gens.current.get(root) !== gen) return;
        setTabs((ts) =>
          ts.map((t) =>
            t.root === root
              ? {
                  ...t,
                  info,
                  commits: log,
                  filterBranch: filter.branch,
                  logLimit: filter.limit,
                  branches,
                  status: st,
                  opState,
                  stashes,
                  // Solo se precarga una vez; si Bernardo ya eligió otra base
                  // no se le pisa en cada recarga.
                  rebaseTarget: t.rebaseTarget || defaultBase || "",
                  loading: false,
                  error: null,
                  // Tras recargar, el diff podría estar obsoleto; se limpia la
                  // selección y se vuelve a elegir.
                  sel: null,
                  diff: null,
                  diffLoading: false,
                }
              : t,
          ),
        );
      } catch (e) {
        if (gens.current.get(root) !== gen) return;
        // La rama filtrada pudo desaparecer (fetch --prune, borrada desde otra
        // herramienta): `git log <ref>` falla y con él toda la recarga. Se
        // vuelve a ver todas las ramas y se reintenta una vez (sin rama ya no
        // puede repetirse el mismo fallo).
        if (filter.branch) {
          filters.current.set(root, { ...filter, branch: null });
          patchTab(root, { filterBranch: null });
          void reload(root, opts);
          return;
        }
        const msg = isGitError(e) ? e.message : String(e);
        if (opts?.dropOnError) {
          // Repo movido/borrado desde la última sesión: se quita la pestaña en
          // vez de dejarla clavada en un banner rojo en cada arranque.
          gens.current.delete(root);
          setTabs((ts) => {
            const next = ts.filter((t) => t.root !== root);
            persistTabs(next);
            return next;
          });
          return;
        }
        setTabs((ts) =>
          ts.map((t) => (t.root === root ? { ...t, loading: false, error: msg } : t)),
        );
      }
    },
    [],
  );

  const loadDiff = useCallback(async (root: string, sel: Selection) => {
    const asContent = sel.t === "commit" && sel.view === "content";
    setTabs((ts) =>
      ts.map((t) =>
        t.root === root
          ? {
              ...t,
              sel,
              diff: null,
              diffLoading: !asContent,
              content: null,
              contentLoading: asContent,
            }
          : t,
      ),
    );
    // Explorador «Todos los archivos»: el archivo entero en ese commit, no su diff.
    if (sel.t === "commit" && sel.view === "content" && sel.file) {
      try {
        const content = await getFileContent(root, sel.hash, sel.file);
        setTabs((ts) =>
          ts.map((t) =>
            t.root === root && sameSelection(t.sel, sel)
              ? { ...t, content, contentLoading: false }
              : t,
          ),
        );
      } catch (e) {
        const msg = isGitError(e) ? e.message : String(e);
        setTabs((ts) =>
          ts.map((t) =>
            t.root === root && sameSelection(t.sel, sel)
              ? { ...t, content: null, contentLoading: false, error: msg }
              : t,
          ),
        );
      }
      return;
    }
    // Un archivo sin seguir no tiene con qué compararse: no se llama a git. Un
    // commit de fusión sí: el backend lo compara contra su primer padre.
    if (sel.t === "file" && sel.untracked) {
      setTabs((ts) =>
        ts.map((t) =>
          t.root === root && sameSelection(t.sel, sel)
            ? { ...t, diff: null, diffLoading: false }
            : t,
        ),
      );
      return;
    }
    try {
      const raw =
        sel.t === "commit"
          ? sel.file
            ? await getCommitFileDiff(root, sel.hash, sel.file, sel.origPath ?? null)
            : await getCommitDiff(root, sel.hash)
          : await getFileDiff(root, sel.path, sel.staged);
      setTabs((ts) =>
        ts.map((t) =>
          // Clics rápidos: solo aplica si la selección sigue vigente.
          t.root === root && sameSelection(t.sel, sel)
            ? { ...t, diff: raw, diffLoading: false }
            : t,
        ),
      );
    } catch (e) {
      const msg = isGitError(e) ? e.message : String(e);
      setTabs((ts) =>
        ts.map((t) =>
          t.root === root && sameSelection(t.sel, sel)
            ? { ...t, diff: null, diffLoading: false, error: msg }
            : t,
        ),
      );
    }
  }, []);

  /** Se llama al seleccionar un commit distinto (no al picar un archivo dentro
   * del mismo commit, que reusa la lista ya cargada). */
  const loadCommitFiles = useCallback(
    async (root: string, hash: string) => {
      setTabs((ts) =>
        ts.map((t) =>
          t.root === root ? { ...t, commitFilesLoading: true } : t,
        ),
      );
      try {
        const files = await getCommitFiles(root, hash);
        setTabs((ts) =>
          ts.map((t) =>
            t.root === root && t.sel?.t === "commit" && t.sel.hash === hash
              ? { ...t, commitFiles: files, commitFilesLoading: false }
              : t,
          ),
        );
      } catch (e) {
        const msg = isGitError(e) ? e.message : String(e);
        setTabs((ts) =>
          ts.map((t) =>
            t.root === root && t.sel?.t === "commit" && t.sel.hash === hash
              ? { ...t, commitFiles: [], commitFilesLoading: false, error: msg }
              : t,
          ),
        );
      }
    },
    [],
  );

  /** Pide el árbol completo de un commit. `treeHash` se fija al pedir (no al
   * recibir) para que el efecto que lo dispara no lo repita en bucle, y el
   * resultado solo se aplica si el árbol pedido sigue siendo ese. */
  const loadTree = useCallback(async (root: string, hash: string) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.root === root ? { ...t, treeHash: hash, treeLoading: true, treePaths: [] } : t,
      ),
    );
    try {
      const paths = await getTreeFiles(root, hash);
      setTabs((ts) =>
        ts.map((t) =>
          t.root === root && t.treeHash === hash
            ? { ...t, treePaths: paths, treeLoading: false }
            : t,
        ),
      );
    } catch (e) {
      const msg = isGitError(e) ? e.message : String(e);
      setTabs((ts) =>
        ts.map((t) =>
          t.root === root && t.treeHash === hash
            ? { ...t, treePaths: [], treeLoading: false, error: msg }
            : t,
        ),
      );
    }
  }, []);

  const patchTab = useCallback((root: string, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.root === root ? { ...t, ...patch } : t)));
  }, []);

  const failTab = useCallback(
    (root: string, e: unknown) => {
      patchTab(root, {
        error: isGitError(e) ? e.message : String(e),
        committing: false,
        remoting: null,
        opBusy: false,
        stashBusy: false,
        cherryBusy: false,
        rebasing: false,
        refBusy: false,
      });
    },
    [patchTab],
  );

  // Un rebase/cherry-pick/continue que "falla" por un conflicto no es un
  // error de conexión: el repo queda en un estado real (a medias) que hay
  // que reflejar. `failTab` solo pone el mensaje; sin esto `opState` se
  // queda en `null` para siempre, el banner naranja nunca aparece y nada se
  // bloquea — descubierto clicando la UI real, no con `invoke` crudo (el
  // catch nunca refrescaba, aunque `op_state` en Rust siempre fue correcto).
  // No se usa `reload()` a secas porque esta limpia `error` al empezar y lo
  // volvería a poner a `null` al terminar bien, borrando el mensaje de git.
  const refreshVolatile = useCallback(async (root: string) => {
    // Token capturado al entrar: si un `reload()` corre mientras esta llamada
    // está en vuelo (p. ej. Bernardo pulsa "Recargar" justo tras un alt-tab),
    // su resultado, más fresco, no debe ser pisado por este cuando termine.
    const gen = gens.current.get(root) ?? 0;
    try {
      const filter = filters.current.get(root) ?? DEFAULT_VIEW;
      const [info, opState, status, branches, stashes, log] = await Promise.all([
        // Sin esto `head_hash` queda obsoleto tras un commit hecho fuera de
        // gitpad: el nodo //WIP se dibujaría enganchado al HEAD viejo (se
        // saltaría el commit más nuevo) justo en el camino que existe para
        // esto — volver de un alt-tab tras commitear desde otra herramienta.
        openRepo(root),
        getOpState(root),
        getStatus(root),
        getBranches(root),
        getStashes(root),
        // `filter.limit`, no LOG_PAGE: si Bernardo ya cargó más páginas, un
        // alt-tab no debe encogerle la lista.
        getLog(root, 0, filter.limit, filter.mode, filter.query, filter.branch),
      ]);
      if (gens.current.get(root) !== gen) return;
      patchTab(root, { info, opState, status, branches, stashes, commits: log });
    } catch {
      // Si esto también falla, se queda el mensaje de error genérico y ya.
    }
  }, [patchTab]);

  const toggleStage = useCallback(
    async (root: string, paths: string[], stage: boolean) => {
      try {
        if (stage) await stagePaths(root, paths);
        else await unstagePaths(root, paths);
        await reload(root);
      } catch (e) {
        failTab(root, e);
      }
    },
    [reload, failTab],
  );

  const doDiscard = useCallback(
    async (root: string, paths: string[], origPaths: string[], untracked: boolean) => {
      const msg = untracked
        ? `¿Borrar ${paths.length === 1 ? "este archivo" : "estos archivos"} sin seguir? No se puede deshacer.`
        : `¿Descartar los cambios de ${paths.length === 1 ? "este archivo" : "estos archivos"}? No se puede deshacer.`;
      if (!window.confirm(msg)) return;
      try {
        await discardPaths(root, paths, origPaths, untracked);
        await reload(root);
      } catch (e) {
        failTab(root, e);
      }
    },
    [reload, failTab],
  );

  const doCommit = useCallback(
    async (root: string, subject: string, body: string, amend: boolean) => {
      if (!subject.trim()) return;
      if (amend && !window.confirm("¿Reescribir el último commit?")) return;
      // Sin descripción se manda solo el resumen: nada de líneas en blanco de más.
      const message = body.trim() ? `${subject.trim()}\n\n${body.trim()}` : subject.trim();
      patchTab(root, { committing: true, error: null });
      try {
        await commitRepo(root, message, amend);
        patchTab(root, {
          commitSubject: "",
          commitBody: "",
          amend: false,
          amendDraft: null,
          committing: false,
        });
        await reload(root);
      } catch (e) {
        failTab(root, e);
      }
    },
    [reload, patchTab, failTab],
  );

  const doRemote = useCallback(
    async (root: string, op: "fetch" | "pull" | "push") => {
      patchTab(root, { remoting: op, error: null });
      try {
        if (op === "fetch") await fetchRemote(root);
        else if (op === "pull") await pullRemote(root);
        else await pushRemote(root);
        patchTab(root, { remoting: null });
        await reload(root);
      } catch (e) {
        failTab(root, e);
      }
    },
    [reload, patchTab, failTab],
  );

  const doOpContinue = useCallback(
    async (root: string) => {
      patchTab(root, { opBusy: true, error: null });
      try {
        await opContinue(root);
        patchTab(root, { opBusy: false });
        await reload(root);
      } catch (e) {
        failTab(root, e);
        // Si "continue" falla es normal que aún queden conflictos por
        // resolver: op_state sigue siendo el mismo, pero status puede haber
        // cambiado con lo que ya se resolvió a mano.
        await refreshVolatile(root);
      }
    },
    [reload, patchTab, failTab, refreshVolatile],
  );

  const doOpAbort = useCallback(
    async (root: string) => {
      if (!window.confirm("¿Abortar y volver al estado de antes de empezar?")) return;
      patchTab(root, { opBusy: true, error: null });
      try {
        await opAbort(root);
        patchTab(root, { opBusy: false });
        await reload(root);
      } catch (e) {
        failTab(root, e);
        await refreshVolatile(root);
      }
    },
    [reload, patchTab, failTab, refreshVolatile],
  );

  const doStashPush = useCallback(
    async (root: string, message: string, includeUntracked: boolean) => {
      patchTab(root, { stashBusy: true, error: null });
      try {
        await stashPush(root, message, includeUntracked);
        patchTab(root, { stashBusy: false, stashMsg: "" });
        await reload(root);
      } catch (e) {
        failTab(root, e);
      }
    },
    [reload, patchTab, failTab],
  );

  const doStashApply = useCallback(
    async (root: string, index: number, pop: boolean) => {
      patchTab(root, { stashBusy: true, error: null });
      try {
        await stashApply(root, index, pop);
        patchTab(root, { stashBusy: false });
        await reload(root);
      } catch (e) {
        failTab(root, e);
        // Un conflicto al aplicar deja archivos sin fusionar en el árbol
        // (sin op_state — stash no tiene --continue/--abort): refrescar
        // status para que el panel de Cambios los enseñe.
        await refreshVolatile(root);
      }
    },
    [reload, patchTab, failTab, refreshVolatile],
  );

  const doStashDrop = useCallback(
    async (root: string, index: number) => {
      if (!window.confirm("¿Borrar este stash? No se puede deshacer.")) return;
      patchTab(root, { stashBusy: true, error: null });
      try {
        await stashDrop(root, index);
        patchTab(root, { stashBusy: false });
        await reload(root);
      } catch (e) {
        failTab(root, e);
      }
    },
    [reload, patchTab, failTab],
  );

  const doCherryPick = useCallback(
    async (root: string, hash: string) => {
      patchTab(root, { cherryBusy: true, error: null });
      try {
        await cherryPick(root, hash);
        patchTab(root, { cherryBusy: false });
        await reload(root);
      } catch (e) {
        failTab(root, e);
        // Un cherry-pick en conflicto deja CHERRY_PICK_HEAD: sin esto el
        // banner de "en curso" nunca aparece y nada queda bloqueado.
        await refreshVolatile(root);
      }
    },
    [reload, patchTab, failTab, refreshVolatile],
  );

  const doRebase = useCallback(
    async (root: string, onto: string) => {
      if (!onto.trim()) return;
      if (!window.confirm(`¿Hacer rebase de la rama activa sobre "${onto}"?`)) return;
      patchTab(root, { rebasing: true, error: null });
      try {
        await rebaseOnto(root, onto);
        patchTab(root, { rebasing: false });
        await reload(root);
      } catch (e) {
        failTab(root, e);
        await refreshVolatile(root);
      }
    },
    [reload, patchTab, failTab, refreshVolatile],
  );

  const doMerge = useCallback(
    async (root: string, branch: Branch) => {
      if (!window.confirm(`¿Hacer merge de "${branch.name}" en la rama activa?`)) return;
      patchTab(root, { refBusy: true, error: null });
      try {
        await mergeBranch(root, branchRef(branch));
        patchTab(root, { refBusy: false });
        await reload(root);
      } catch (e) {
        // Un conflicto deja el merge a medias: refrescar para que aparezca el banner.
        failTab(root, e);
        await refreshVolatile(root);
      }
    },
    [reload, patchTab, failTab, refreshVolatile],
  );

  // Operaciones sobre ramas/tags que no dejan el repo a medias: si fallan basta
  // con mostrar el error (no hace falta `refreshVolatile`, a diferencia del merge).
  const refOp = useCallback(
    async (root: string, run: () => Promise<void>) => {
      patchTab(root, { refBusy: true, error: null });
      try {
        await run();
        patchTab(root, { refBusy: false });
        await reload(root);
      } catch (e) {
        failTab(root, e);
      }
    },
    [reload, patchTab, failTab],
  );

  const doCreateBranch = useCallback(
    (root: string, at?: string) => {
      const name = window
        .prompt(
          `Nombre de la rama nueva (se crea ${at ? "en este commit" : "en HEAD"} y se cambia a ella):`,
        )
        ?.trim();
      if (name) void refOp(root, () => createBranch(root, name, at));
    },
    [refOp],
  );

  const doRenameBranch = useCallback(
    (root: string, b: Branch) => {
      const name = window.prompt(`Nuevo nombre para la rama "${b.name}":`, b.name)?.trim();
      if (name && name !== b.name) void refOp(root, () => renameBranch(root, b.name, name));
    },
    [refOp],
  );

  const doDeleteBranch = useCallback(
    (root: string, b: Branch) => {
      if (!window.confirm(`¿Borrar la rama "${b.name}"? Solo la local; el remoto no se toca.`))
        return;
      void refOp(root, async () => {
        try {
          await deleteBranch(root, b.name, false);
        } catch (e) {
          // Solo este error se resuelve forzando: cualquier otro se muestra tal cual.
          const forzar =
            isGitError(e) &&
            e.kind === "not_merged" &&
            window.confirm(
              `"${b.name}" tiene commits que no están en la rama actual y se perderían.\n\n¿Borrarla igualmente?`,
            );
          if (!forzar) throw e;
          await deleteBranch(root, b.name, true);
        }
      });
    },
    [refOp],
  );

  const doCreateTag = useCallback(
    (root: string, at?: string) => {
      const name = window
        .prompt(`Nombre del tag (se crea ${at ? "en este commit" : "en HEAD"}):`)
        ?.trim();
      if (name) void refOp(root, () => createTag(root, name, at));
    },
    [refOp],
  );

  const doDeleteTag = useCallback(
    (root: string, name: string) => {
      if (!window.confirm(`¿Borrar el tag "${name}"? Solo el local; el remoto no se toca.`)) return;
      void refOp(root, () => deleteTag(root, name));
    },
    [refOp],
  );

  const applyFilter = useCallback(
    (root: string, mode: LogFilterMode, query: string) => {
      patchTab(root, { filterMode: mode, filterQuery: query });
      void reload(root, { filter: { mode, query } });
    },
    [reload, patchTab],
  );

  /** Limita el log a una rama (ref completa) o, con null, vuelve a verlas todas.
   * El clic en la rama sigue siendo checkout: esto es un control aparte. */
  const applyBranch = useCallback(
    (root: string, branch: string | null) => {
      patchTab(root, { filterBranch: branch });
      void reload(root, { filter: { branch } });
    },
    [reload, patchTab],
  );

  /** Pide otra página. Se refetchea desde 0 con un límite mayor en vez de
   * pedir con `skip` y concatenar: con commits nuevos entrando entre páginas
   * los offsets se corren y salen filas repetidas. No pasa por `reload`, que
   * limpia la selección. */
  const loadMore = useCallback(
    async (root: string) => {
      const view = filters.current.get(root) ?? DEFAULT_VIEW;
      const limit = view.limit + LOG_PAGE;
      const gen = gens.current.get(root) ?? 0;
      // El límite nuevo se publica ANTES del await: un refresco por foco que
      // llegue mientras la página está en vuelo pediría el límite viejo, y al
      // resolver después encogería la lista dejando `logLimit` desfasado (el
      // botón "Cargar más" desaparecería).
      filters.current.set(root, { ...view, limit });
      try {
        const log = await getLog(root, 0, limit, view.mode, view.query, view.branch);
        if (gens.current.get(root) !== gen) return;
        patchTab(root, { commits: log, logLimit: limit });
      } catch (e) {
        filters.current.set(root, view);
        failTab(root, e);
      }
    },
    [patchTab, failTab],
  );

  const doCheckout = useCallback(
    async (root: string, name: string) => {
      patchTab(root, { error: null });
      try {
        await checkoutBranch(root, name);
        await reload(root);
      } catch (e) {
        failTab(root, e);
      }
    },
    [reload, patchTab, failTab],
  );

  // Restaura las pestañas de la sesión anterior una sola vez.
  useEffect(() => {
    const roots = restoreRoots();
    if (roots.length === 0) return;
    const savedActive = localStorage.getItem(ACTIVE_KEY);
    setTabs(roots.map(emptyTab));
    setActiveRoot(roots.includes(savedActive ?? "") ? savedActive : roots[0]);
    roots.forEach((r) => void reload(r, { dropOnError: true }));
  }, [reload]);

  // Bernardo commitea a veces desde otra herramienta y vuelve a gitpad: sin
  // esto veía la lista de commits desactualizada hasta pulsar "Recargar" a
  // mano. Se usa `refreshVolatile`, no `reload`, porque `reload` resetea
  // `sel`/`diff` y perdería el commit/diff que tuviera abierto en ese momento.
  useEffect(() => {
    const onFocus = () => {
      if (activeRoot) void refreshVolatile(activeRoot);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeRoot, refreshVolatile]);

  // Invariante: `activeRoot` siempre apunta a una pestaña existente (o null).
  useEffect(() => {
    if (tabs.length === 0) {
      if (activeRoot !== null) {
        setActiveRoot(null);
        persistActive(null);
      }
      return;
    }
    if (!tabs.some((t) => t.root === activeRoot)) {
      setActiveRoot(tabs[0].root);
      persistActive(tabs[0].root);
    }
  }, [tabs, activeRoot]);

  const onPick = async () => {
    const path = await pickRepoFolder();
    if (!path) return;
    setOpening(true);
    setOpenError(null);
    try {
      const info = await openRepo(path);
      if (tabs.some((t) => t.root === info.root)) {
        if (info.root !== activeRoot) introPending.current = true;
        setActiveRoot(info.root);
        persistActive(info.root);
        return;
      }
      const next = [...tabs, { ...emptyTab(info.root), info }];
      setTabs(next);
      persistTabs(next);
      introPending.current = true;
      setActiveRoot(info.root);
      persistActive(info.root);
      void reload(info.root);
    } catch (e) {
      setOpenError(isGitError(e) ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  const selectTab = (root: string) => {
    if (root !== activeRoot) introPending.current = true;
    setActiveRoot(root);
    persistActive(root);
  };

  const closeTab = (root: string) => {
    const idx = tabs.findIndex((t) => t.root === root);
    const next = tabs.filter((t) => t.root !== root);
    gens.current.delete(root);
    filters.current.delete(root);
    setTabs(next);
    persistTabs(next);
    if (activeRoot === root) {
      const neighbour = next[idx] ?? next[next.length - 1] ?? null;
      setActiveRoot(neighbour?.root ?? null);
      persistActive(neighbour?.root ?? null);
    }
  };

  /** Mueve la pestaña `from` a la posición de `to`. `activeRoot` se identifica
   * por ruta, no por índice, así que reordenar no cambia la pestaña activa. */
  const moveTab = (from: string, to: string) => {
    const fi = tabs.findIndex((t) => t.root === from);
    const ti = tabs.findIndex((t) => t.root === to);
    if (fi < 0 || ti < 0 || fi === ti) return;
    const next = [...tabs];
    const [moved] = next.splice(fi, 1);
    next.splice(ti, 0, moved);
    setTabs(next);
    persistTabs(next);
  };

  const active = tabs.find((t) => t.root === activeRoot) ?? null;

  // «Todos los archivos»: el árbol es el del commit seleccionado, o el de HEAD
  // si no hay ninguno (árbol de trabajo). Se (re)pide al cambiar ese objetivo.
  const treeTarget =
    active?.sel?.t === "commit" ? active.sel.hash : (active?.info?.head_hash ?? null);
  useEffect(() => {
    if (active && active.filesScope === "all" && treeTarget && treeTarget !== active.treeHash)
      void loadTree(active.root, treeTarget);
  }, [active?.root, active?.filesScope, active?.treeHash, treeTarget, loadTree]);

  useEffect(() => {
    if (introPending.current && active && !active.loading && active.commits.length > 0) {
      introPending.current = false;
      setIntroOn(true);
      window.setTimeout(() => setIntroOn(false), 900);
    }
  }, [active?.root, active?.loading, active?.commits.length]);
  const onRefresh = () => {
    if (active) void reload(active.root);
  };

  // Nodo //WIP (equivalente al de GitKraken): solo tiene sentido si hay
  // cambios sin comprometer Y se sabe a qué commit engancharlo. Se antepone
  // aquí, no en `Graph.tsx`, para que el mismo array alimente el SVG y la
  // lista — así nunca pueden desalinearse entre sí.
  // Tampoco al ver solo otra rama: el WIP es del árbol de trabajo de la rama
  // activa y quedaría colgado, con trazo discontinuo, de un commit que no se
  // ve en la lista.
  const showWip = !!(
    active?.status &&
    active.status.entries.length > 0 &&
    active.info?.head_hash &&
    (!active.filterBranch || active.filterBranch === `refs/heads/${active.info.head}`)
  );
  const displayCommits =
    showWip && active
      ? [wipCommit(active.info!.head_hash!), ...active.commits]
      : (active?.commits ?? []);

  const openMenu = (ev: React.MouseEvent, heading: string, items: MenuItem[]) => {
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({ x: ev.clientX, y: ev.clientY, heading, items });
  };
  // Con una operación a medias (conflicto) o en marcha solo quedan vivos
  // Continuar/Abortar del banner: el resto de acciones del menú se apagan.
  const menuBusy = !!active && (active.opState !== null || active.refBusy || active.rebasing);
  const branchItems = (root: string, b: Branch, blocked: boolean): MenuItem[] => [
    {
      label: "Checkout",
      disabled: blocked || b.is_head,
      onSelect: () => void doCheckout(root, b.checkout_arg),
    },
    {
      label: "Merge en la rama actual",
      disabled: menuBusy || b.is_head,
      onSelect: () => void doMerge(root, b),
    },
    ...(b.is_remote
      ? []
      : [
          { label: "Renombrar…", disabled: menuBusy, onSelect: () => doRenameBranch(root, b) },
          {
            label: "Borrar…",
            danger: true,
            disabled: menuBusy || b.is_head,
            title: b.is_head ? "No se puede borrar la rama activa" : undefined,
            onSelect: () => doDeleteBranch(root, b),
          },
        ]),
  ];
  const commitItems = (root: string, c: Commit): MenuItem[] => [
    { label: "Crear rama aquí…", disabled: menuBusy, onSelect: () => doCreateBranch(root, c.hash) },
    { label: "Crear tag aquí…", disabled: menuBusy, onSelect: () => doCreateTag(root, c.hash) },
  ];

  return (
    <div className="app" style={{ "--row-h": `${ROW_H}px` } as React.CSSProperties}>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      <header className="topbar">
        <button onClick={onPick} disabled={opening}>
          {opening ? "Abriendo…" : "Abrir repo…"}
        </button>
        {active && (
          <>
            <span className="repo-name" title={active.root}>
              {basename(active.root)}
            </span>
            <span className="branch">
              {active.info?.head ?? "HEAD desprendido"}
            </span>
            {active.status &&
              (active.status.ahead > 0 || active.status.behind > 0) && (
                <span className="ab">
                  {active.status.ahead > 0 && `↑${active.status.ahead}`}
                  {active.status.behind > 0 && ` ↓${active.status.behind}`}
                </span>
              )}
            <button
              className={busyClass(active.loading)}
              onClick={onRefresh}
              disabled={active.loading}
            >
              Recargar
            </button>
            <button
              className={busyClass(active.remoting === "fetch")}
              onClick={() => void doRemote(active.root, "fetch")}
              disabled={active.remoting !== null}
            >
              Fetch
            </button>
            <button
              className={busyClass(active.remoting === "pull")}
              onClick={() => void doRemote(active.root, "pull")}
              disabled={active.remoting !== null}
            >
              Pull
            </button>
            <button
              className={busyClass(active.remoting === "push")}
              onClick={() => void doRemote(active.root, "push")}
              disabled={active.remoting !== null}
            >
              Push
            </button>
            <button
              className={busyClass(active.stashBusy)}
              title="Guardar todos los cambios en un stash nuevo"
              disabled={
                active.stashBusy ||
                active.opState !== null ||
                !active.status ||
                active.status.entries.length === 0
              }
              onClick={() => void doStashPush(active.root, "", true)}
            >
              Stash
            </button>
            <button
              className={busyClass(active.stashBusy)}
              title="Aplicar el stash más reciente y quitarlo de la lista"
              disabled={
                active.stashBusy || active.opState !== null || active.stashes.length === 0
              }
              onClick={() =>
                active.stashes[0] &&
                void doStashApply(active.root, active.stashes[0].index, true)
              }
            >
              Pop
            </button>
            <form
              className="search"
              onSubmit={(ev) => {
                ev.preventDefault();
                applyFilter(active.root, active.filterMode, active.filterQuery);
              }}
            >
              <select
                value={active.filterMode}
                onChange={(ev) =>
                  patchTab(active.root, {
                    filterMode: ev.target.value as LogFilterMode,
                  })
                }
              >
                <option value="message">Mensaje</option>
                <option value="content">Contenido</option>
              </select>
              <input
                type="text"
                placeholder="Buscar commits…"
                value={active.filterQuery}
                onChange={(ev) =>
                  patchTab(active.root, { filterQuery: ev.target.value })
                }
              />
              <button type="submit" disabled={!active.filterQuery.trim()}>
                Buscar
              </button>
            </form>
          </>
        )}
        {active?.loading && <div className="progress" role="progressbar" aria-label="Cargando" />}
      </header>

      {tabs.length > 0 && (
        <nav className="tabs">
          {tabs.map((t) => (
            <div
              key={t.root}
              className={`tab${t.root === activeRoot ? " active" : ""}${
                dragOver === t.root && dragRoot !== t.root ? " drop-target" : ""
              }${dragRoot === t.root ? " dragging" : ""}`}
              onClick={() => selectTab(t.root)}
              title={t.root}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", t.root);
                setDragRoot(t.root);
              }}
              onDragOver={(e) => {
                if (dragRoot === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOver !== t.root) setDragOver(t.root);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragRoot !== null) moveTab(dragRoot, t.root);
                setDragRoot(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragRoot(null);
                setDragOver(null);
              }}
            >
              <span className="tab-name">{basename(t.root)}</span>
              {t.loading && <span className="tab-spin" aria-hidden="true" />}
              {t.error && !t.loading && <span className="tab-warn">!</span>}
              <button
                className="tab-close"
                aria-label="Cerrar pestaña"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.root);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
      )}

      {openError && <div className="error">{openError}</div>}
      {/* Con una operación en curso, el banner de conflicto (abajo, en
          `.commits`) ya explica qué hacer — el error crudo de git detrás
          (hints en inglés) solo añade ruido para alguien no técnico. */}
      {active?.error && !active.opState && <div className="error">{active.error}</div>}

      {active && (
        <div className="body" ref={panels.bodyRef} style={panels.style}>
          <div {...panels.handleProps("left")} />
          <div {...panels.handleProps("right")} />
          <aside className="branches">
            <div className="branches-head">
              <h2>Ramas</h2>
              <button
                title="Nueva rama en HEAD (o clic derecho en un commit para crearla ahí)"
                aria-label="Nueva rama"
                disabled={menuBusy}
                onClick={() => doCreateBranch(active.root)}
              >
                ＋
              </button>
            </div>
            {(["local", "remote"] as const).map((group) => {
              const list = active.branches.filter((b) =>
                group === "local" ? !b.is_remote : b.is_remote,
              );
              if (list.length === 0) return null;
              return (
                <div key={group}>
                  <div className="branch-group-label">
                    {group === "local" ? "Locales" : "Remotas"}
                  </div>
                  <ul>
                    {list.map((b) => {
                      const locked = b.worktree_path !== null && !b.is_head;
                      // Durante un rebase/cherry-pick/merge a medias no se
                      // puede cambiar de rama: solo quedan vivos Continuar y
                      // Abortar en el banner de arriba.
                      const blocked = locked || active.opState !== null;
                      return (
                        <li
                          key={b.name}
                          className={`branch-item${b.is_head ? " current" : ""}${
                            locked ? " locked" : ""
                          }`}
                          title={
                            active.opState
                              ? "Hay una operación en curso — continúa o aborta antes de cambiar de rama"
                              : locked
                                ? `Abierta en otro worktree: ${b.worktree_path}`
                                : b.name
                          }
                          onClick={() =>
                            !blocked && void doCheckout(active.root, b.checkout_arg)
                          }
                          onContextMenu={(ev) =>
                            openMenu(ev, b.name, branchItems(active.root, b, blocked))
                          }
                        >
                          {b.is_head && <span className="dot">●</span>}
                          <span className="branch-name">{b.name}</span>
                          <button
                            className={`link branch-filter${
                              active.filterBranch === branchRef(b) ? " on" : ""
                            }`}
                            title={
                              active.filterBranch === branchRef(b)
                                ? "Volver a ver todas las ramas"
                                : "Ver solo el historial de esta rama"
                            }
                            aria-pressed={active.filterBranch === branchRef(b)}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              applyBranch(
                                active.root,
                                active.filterBranch === branchRef(b) ? null : branchRef(b),
                              );
                            }}
                          >
                            {active.filterBranch === branchRef(b) ? "◉" : "○"}
                          </button>
                          {locked && <span className="lock">⊘</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}

            <div className="rebase-box">
              <div className="branch-group-label">Rebase / Merge</div>
              <select
                value={active.rebaseTarget}
                disabled={active.rebasing || active.refBusy || active.opState !== null}
                onChange={(ev) => patchTab(active.root, { rebaseTarget: ev.target.value })}
              >
                <option value="">Elige una rama…</option>
                {Array.from(new Set(active.branches.map((b) => b.name))).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                className={busyClass(active.rebasing)}
                disabled={
                  active.rebasing ||
                  active.refBusy ||
                  active.opState !== null ||
                  !active.rebaseTarget
                }
                onClick={() => void doRebase(active.root, active.rebaseTarget)}
              >
                Rebase aquí
              </button>
              <button
                className={busyClass(active.refBusy)}
                disabled={
                  active.rebasing ||
                  active.refBusy ||
                  active.opState !== null ||
                  !active.rebaseTarget
                }
                onClick={() => {
                  const b = active.branches.find((x) => x.name === active.rebaseTarget);
                  if (b) void doMerge(active.root, b);
                }}
              >
                Merge aquí
              </button>
            </div>
          </aside>

          <section className="commits">
            {active.opState && (
              <p className="conflict-banner">
                {active.opState.kind === "rebase" && "Rebase en curso"}
                {active.opState.kind === "cherry_pick" && "Cherry-pick en curso"}
                {active.opState.kind === "merge" && "Merge en curso"}
                {" — resuelve los archivos en conflicto en tu editor, haz stage (＋) y luego:"}
                <button
                  className={busyClass(active.opBusy)}
                  disabled={active.opBusy}
                  onClick={() => void doOpContinue(active.root)}
                >
                  Continuar
                </button>
                <button
                  className={busyClass(active.opBusy)}
                  disabled={active.opBusy}
                  onClick={() => void doOpAbort(active.root)}
                >
                  Abortar
                </button>
              </p>
            )}
            {active.filterBranch && (
              <p className="filter-info">
                Viendo solo <strong>{branchLabel(active.filterBranch)}</strong> ·{" "}
                <button className="link" onClick={() => applyBranch(active.root, null)}>
                  ver todas
                </button>
              </p>
            )}
            {active.filterQuery.trim() && (
              <p className="filter-info">
                {active.commits.length} resultados para «{active.filterQuery}» ·{" "}
                <button
                  className="link"
                  onClick={() => applyFilter(active.root, active.filterMode, "")}
                >
                  limpiar
                </button>
              </p>
            )}
            <div className={`commit-list${introOn ? " intro" : ""}`}>
              <Graph commits={displayCommits} />
              <ol>
                {displayCommits.map((c) => {
                  if (c.hash === WIP_HASH) {
                    // Entrada al panel "Cambios": mismo gesto que en
                    // GitKraken (clicar el nodo //WIP), en vez de depender de
                    // reclicar el commit ya seleccionado.
                    const wipOn = active.sel === null;
                    return (
                      <li
                        key="wip"
                        className={`commit wip${wipOn ? " sel" : ""}`}
                        onClick={() =>
                          patchTab(active.root, { sel: null, diff: null, commitFiles: [] })
                        }
                      >
                        <div className="commit-line">
                          <span className="subject">//WIP</span>
                        </div>
                        <div className="commit-meta">
                          <span>
                            {active.status?.entries.length} cambios sin comprometer
                          </span>
                        </div>
                      </li>
                    );
                  }
                  const on =
                    active.sel?.t === "commit" && active.sel.hash === c.hash;
                  const isMerge = c.parents.length > 1;
                  return (
                    <li
                      key={c.hash}
                      className={`commit${on ? " sel" : ""}`}
                      onContextMenu={(ev) =>
                        // El nodo //WIP no es un commit real: sin menú (y sin el nativo).
                        c.hash === WIP_HASH
                          ? ev.preventDefault()
                          : openMenu(ev, `${c.short_hash} ${c.subject}`, commitItems(active.root, c))
                      }
                      onClick={() => {
                        // Reclicar el commit ya seleccionado lo deselecciona:
                        // vuelve al panel "Cambios" (lo mismo que clicar el
                        // nodo //WIP, cuando lo hay).
                        if (on) {
                          patchTab(active.root, {
                            sel: null,
                            diff: null,
                            commitFiles: [],
                          });
                          return;
                        }
                        void loadDiff(active.root, {
                          t: "commit",
                          hash: c.hash,
                          isMerge,
                        });
                        void loadCommitFiles(active.root, c.hash);
                      }}
                    >
                      <div className="commit-line">
                        {c.refs.map((r, i) => (
                          <span
                            // El chip HEAD lleva el hash en la key: al cambiar de
                            // commit (checkout, commit nuevo) se remonta y repite
                            // su pulso una vez.
                            key={`${i}-${r.kind}-${r.name}${r.kind === "head" ? active.info?.head_hash : ""}`}
                            className={`ref ${r.kind}`}
                            title={r.kind === "tag" ? `tag ${r.name}` : r.name}
                            onContextMenu={
                              r.kind === "tag"
                                ? (ev) =>
                                    openMenu(ev, `tag ${r.name}`, [
                                      {
                                        label: "Borrar tag…",
                                        danger: true,
                                        disabled: menuBusy,
                                        onSelect: () => doDeleteTag(active.root, r.name),
                                      },
                                    ])
                                : undefined
                            }
                          >
                            {r.name}
                          </span>
                        ))}
                        <span className="subject">{c.subject}</span>
                      </div>
                      <div className="commit-meta">
                        <code>{c.short_hash}</code>
                        <span>{c.author_name}</span>
                        <span title={new Date(c.date).toLocaleString()}>{shortDate(c.date)}</span>
                        {!isMerge && (
                          <button
                            className="link cherry-btn"
                            title="Aplicar este commit sobre la rama activa (cherry-pick)"
                            disabled={active.cherryBusy || active.opState !== null}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              void doCherryPick(active.root, c.hash);
                            }}
                          >
                            {active.cherryBusy ? "…" : "⤵"}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
            {active.commits.length >= active.logLimit && (
              <div className="more">
                <button onClick={() => void loadMore(active.root)}>
                  Cargar más commits
                </button>
              </div>
            )}
          </section>

          <section className="diffpane">
            {active.sel?.t === "commit" && active.sel.view === "content" && active.sel.file ? (
              <FileView
                path={active.sel.file}
                content={active.content}
                loading={active.contentLoading}
              />
            ) : (
              <DiffView
                raw={active.diff}
                loading={active.diffLoading}
                note={
                  active.sel?.t === "file" && active.sel.untracked
                    ? "Archivo sin seguir — todavía no hay nada que comparar."
                    : undefined
                }
              />
            )}
          </section>

          <aside className="status">
            <div className="diff-toolbar files-toggle" role="group" aria-label="Qué archivos mostrar">
              <button
                className={active.filesScope === "changes" ? "on" : ""}
                onClick={() => patchTab(active.root, { filesScope: "changes" })}
              >
                Cambios
              </button>
              <button
                className={active.filesScope === "all" ? "on" : ""}
                onClick={() => patchTab(active.root, { filesScope: "all" })}
              >
                Todos los archivos
              </button>
            </div>
            {active.filesScope === "all" ? (
              <>
                {(() => {
                  const sel = active.sel;
                  if (sel?.t !== "commit") return null;
                  const c = active.commits.find((cm) => cm.hash === sel.hash);
                  return c ? (
                    <div className="commit-message">
                      <p className="commit-subject">{c.subject}</p>
                      {c.body && <p className="commit-body">{c.body}</p>}
                    </div>
                  ) : null;
                })()}
                <h2>
                  {active.sel?.t === "commit"
                    ? "Todos los archivos en este commit"
                    : "Todos los archivos en HEAD"}
                </h2>
                {!treeTarget ? (
                  <p className="clean">Este repo aún no tiene commits.</p>
                ) : active.treeLoading || active.treeHash !== treeTarget ? (
                  <div className="skeleton" role="status" aria-label="Cargando archivos">
                    {[80, 60, 72].map((w, i) => (
                      <span key={i} className="skel-bar" style={{ width: `${w}%` }} />
                    ))}
                  </div>
                ) : active.treePaths.length === 0 ? (
                  <p className="clean">Sin archivos.</p>
                ) : (
                  <div className="tree-scroll">
                    <FileTree
                      items={active.treePaths}
                      getPath={(p) => p}
                      defaultOpen={false}
                      renderLeaf={(p, name, depth) => {
                        const sel = active.sel;
                        const on = sel?.t === "commit" && sel.view === "content" && sel.file === p;
                        return (
                          <li
                            key={p}
                            className={`entry${on ? " sel" : ""}`}
                            style={{ paddingLeft: leafIndent(depth) }}
                            onClick={() => {
                              const sameCommit = sel?.t === "commit" && sel.hash === treeTarget;
                              const isMerge =
                                (active.commits.find((c) => c.hash === treeTarget)?.parents
                                  .length ?? 0) > 1;
                              void loadDiff(active.root, {
                                t: "commit",
                                hash: treeTarget,
                                isMerge,
                                file: p,
                                view: "content",
                              });
                              // Al saltar del árbol de trabajo a HEAD, «Cambios» debe
                              // encontrar ya la lista de archivos de ese commit.
                              if (!sameCommit) void loadCommitFiles(active.root, treeTarget);
                            }}
                          >
                            <span className="path" title={p}>
                              {name}
                            </span>
                          </li>
                        );
                      }}
                    />
                  </div>
                )}
              </>
            ) : active.sel?.t === "commit" ? (
              <>
                {(() => {
                  const sel = active.sel;
                  if (sel?.t !== "commit") return null;
                  const c = active.commits.find((cm) => cm.hash === sel.hash);
                  return c ? (
                    <div className="commit-message">
                      <p className="commit-subject">{c.subject}</p>
                      {c.body && <p className="commit-body">{c.body}</p>}
                    </div>
                  ) : null;
                })()}
                <h2>Archivos del commit</h2>
                {active.commitFilesLoading && (
                  <div className="skeleton" role="status" aria-label="Cargando archivos">
                    {[80, 60, 72].map((w, i) => (
                      <span key={i} className="skel-bar" style={{ width: `${w}%` }} />
                    ))}
                  </div>
                )}
                {active.sel.isMerge && (
                  <p className="clean">Merge — cambios respecto al primer padre.</p>
                )}
                {!active.commitFilesLoading && active.commitFiles.length === 0 && (
                  <p className="clean">Sin archivos.</p>
                )}
                {!active.commitFilesLoading && active.commitFiles.length > 0 && (
                  <FilesViewToggle view={filesView} onChange={setFilesView} />
                )}
                {(() => {
                  if (active.commitFilesLoading) return null;
                  const sel = active.sel;
                  // Una hoja del listado: igual en lista y en árbol; solo cambia
                  // la etiqueta (ruta completa vs. nombre) y la sangría.
                  const leaf = (cf: CommitFile, label: string, depth: number) => {
                    const on = sel?.t === "commit" && sel.file === cf.path;
                    return (
                      <li
                        key={cf.path}
                        className={`entry${on ? " sel" : ""}`}
                        style={
                          filesView === "tree" ? { paddingLeft: leafIndent(depth) } : undefined
                        }
                        onClick={() =>
                          sel?.t === "commit" &&
                          void loadDiff(active.root, {
                            t: "commit",
                            hash: sel.hash,
                            isMerge: sel.isMerge,
                            file: cf.path,
                            origPath: cf.orig_path ?? undefined,
                          })
                        }
                      >
                        <span className="xy">
                          <span className="xc hit">{cf.status[0]}</span>
                        </span>
                        <span className="path" title={cf.path}>
                          {label}
                          {filesView === "tree" && cf.orig_path && (
                            <span className="tree-orig"> ← {cf.orig_path}</span>
                          )}
                        </span>
                      </li>
                    );
                  };
                  return filesView === "tree" ? (
                    <FileTree
                      items={active.commitFiles}
                      getPath={(cf) => cf.path}
                      defaultOpen
                      renderLeaf={leaf}
                    />
                  ) : (
                    <ul>
                      {active.commitFiles.map((cf) =>
                        leaf(
                          cf,
                          cf.orig_path ? `${cf.orig_path} → ${cf.path}` : cf.path,
                          0,
                        ),
                      )}
                    </ul>
                  );
                })()}
              </>
            ) : (
              <>
                <h2>Cambios</h2>
                {(() => {
                  const allEntries = active.status?.entries ?? [];
                  // Conflictos aparte: `＋` los marca resueltos, no "stagea"
                  // en el sentido normal — no entran en Stage all/Unstage
                  // all ni en las secciones Unstaged/Staged de abajo, para no
                  // tocar el flujo ya verificado del banner de conflicto.
                  const unmergedEntries = allEntries.filter((e) => e.kind === "unmerged");
                  const otherEntries = allEntries.filter((e) => e.kind !== "unmerged");
                  const unstagedEntries = otherEntries.filter((e) => e.unstaged !== ".");
                  const stagedEntries = otherEntries.filter((e) => e.staged !== ".");

                  const selOn = (path: string, s: boolean) =>
                    active.sel?.t === "file" &&
                    active.sel.path === path &&
                    active.sel.staged === s;

                  if (allEntries.length === 0) {
                    return <p className="clean">Árbol de trabajo limpio</p>;
                  }

                  return (
                    <>
                      {unmergedEntries.length > 0 && (
                        <>
                          <div className="section-header">
                            <h3>Conflictos</h3>
                          </div>
                          <ul>
                            {unmergedEntries.map((e) => (
                              <li
                                key={e.path}
                                className={`entry ${e.kind}${
                                  selOn(e.path, true) || selOn(e.path, false) ? " sel" : ""
                                }`}
                                onClick={() =>
                                  void loadDiff(active.root, {
                                    t: "file",
                                    path: e.path,
                                    staged: false,
                                  })
                                }
                              >
                                <span className="xy">
                                  <span className="xc hit">{e.staged}</span>
                                  <span className="xc hit">{e.unstaged}</span>
                                </span>
                                <span className="path">{e.path}</span>
                                <span className="stagebtns">
                                  <button
                                    title="Marcar como resuelto"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      void toggleStage(active.root, [e.path], true);
                                    }}
                                  >
                                    ＋
                                  </button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}

                      <div className="section-header">
                        <h3>Unstaged</h3>
                        {unstagedEntries.length > 0 && (
                          <button
                            className="link"
                            onClick={() =>
                              void toggleStage(
                                active.root,
                                unstagedEntries.map((e) => e.path),
                                true,
                              )
                            }
                          >
                            Stage all
                          </button>
                        )}
                      </div>
                      <ul>
                        {unstagedEntries.length === 0 && (
                          <li className="clean-row">—</li>
                        )}
                        {unstagedEntries.map((e) => {
                          const untracked = e.unstaged === "?";
                          return (
                            <li
                              key={`u-${e.path}`}
                              className={`entry ${e.kind}${selOn(e.path, false) ? " sel" : ""}`}
                              onClick={() =>
                                void loadDiff(active.root, {
                                  t: "file",
                                  path: e.path,
                                  staged: false,
                                  untracked,
                                })
                              }
                            >
                              <span className="xy">
                                <span className="xc hit">{e.unstaged}</span>
                              </span>
                              <span className="path">
                                {e.orig_path ? `${e.orig_path} → ${e.path}` : e.path}
                              </span>
                              <span className="stagebtns">
                                <button
                                  title="Stage"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    void toggleStage(active.root, [e.path], true);
                                  }}
                                >
                                  ＋
                                </button>
                                <button
                                  title={
                                    untracked
                                      ? "Borrar archivo sin seguir"
                                      : "Descartar cambios"
                                  }
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    void doDiscard(
                                      active.root,
                                      [e.path],
                                      e.orig_path ? [e.orig_path] : [],
                                      untracked,
                                    );
                                  }}
                                >
                                  🗑
                                </button>
                              </span>
                            </li>
                          );
                        })}
                      </ul>

                      <div className="section-header">
                        <h3>Staged</h3>
                        {stagedEntries.length > 0 && (
                          <button
                            className="link"
                            onClick={() =>
                              void toggleStage(
                                active.root,
                                stagedEntries.map((e) => e.path),
                                false,
                              )
                            }
                          >
                            Unstage all
                          </button>
                        )}
                      </div>
                      <ul>
                        {stagedEntries.length === 0 && <li className="clean-row">—</li>}
                        {stagedEntries.map((e) => (
                          <li
                            key={`s-${e.path}`}
                            className={`entry ${e.kind}${selOn(e.path, true) ? " sel" : ""}`}
                            onClick={() =>
                              void loadDiff(active.root, {
                                t: "file",
                                path: e.path,
                                staged: true,
                              })
                            }
                          >
                            <span className="xy">
                              <span className="xc hit">{e.staged}</span>
                            </span>
                            <span className="path">
                              {e.orig_path ? `${e.orig_path} → ${e.path}` : e.path}
                            </span>
                            <span className="stagebtns">
                              <button
                                title="Unstage"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  void toggleStage(active.root, [e.path], false);
                                }}
                              >
                                －
                              </button>
                              <button
                                title="Descartar cambios"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  void doDiscard(
                                    active.root,
                                    [e.path],
                                    e.orig_path ? [e.orig_path] : [],
                                    false,
                                  );
                                }}
                              >
                                🗑
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  );
                })()}
              </>
            )}

            {active.status && active.status.entries.some((e) => e.staged !== ".") && (
              <form
                className="commitbox"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void doCommit(
                    active.root,
                    active.commitSubject,
                    active.commitBody,
                    active.amend,
                  );
                }}
              >
                <input
                  type="text"
                  className="commit-subject-input"
                  placeholder="Resumen"
                  value={active.commitSubject}
                  onChange={(ev) =>
                    patchTab(active.root, { commitSubject: ev.target.value })
                  }
                />
                <textarea
                  placeholder="Descripción (opcional)"
                  value={active.commitBody}
                  rows={3}
                  onChange={(ev) =>
                    patchTab(active.root, { commitBody: ev.target.value })
                  }
                />
                <label className="amend">
                  <input
                    type="checkbox"
                    checked={active.amend}
                    onChange={(ev) => {
                      if (ev.target.checked) {
                        // Precarga resumen y descripción del commit que se
                        // reescribe: sin esto amend pierde el cuerpo en silencio.
                        const head = active.commits.find(
                          (c) => c.hash === active.info?.head_hash,
                        );
                        patchTab(active.root, {
                          amend: true,
                          amendDraft: {
                            subject: active.commitSubject,
                            body: active.commitBody,
                          },
                          ...(head
                            ? { commitSubject: head.subject, commitBody: head.body }
                            : {}),
                        });
                      } else {
                        patchTab(active.root, {
                          amend: false,
                          amendDraft: null,
                          commitSubject: active.amendDraft?.subject ?? "",
                          commitBody: active.amendDraft?.body ?? "",
                        });
                      }
                    }}
                  />
                  Reescribir el último (amend)
                </label>
                <button
                  type="submit"
                  className={busyClass(active.committing)}
                  disabled={
                    active.committing ||
                    !active.commitSubject.trim() ||
                    active.opState !== null
                  }
                >
                  {active.amend ? "Amend" : "Commit"}
                </button>
              </form>
            )}

            <div className="stash-box">
              <h2>Stash</h2>
              <ul>
                {active.stashes.map((s) => (
                  <li key={s.index} className="stash-item">
                    <span className="stash-msg" title={s.message}>
                      {s.message}
                    </span>
                    <button
                      title="Aplicar y quitar de la lista"
                      disabled={active.stashBusy || active.opState !== null}
                      onClick={() => void doStashApply(active.root, s.index, true)}
                    >
                      Pop
                    </button>
                    <button
                      title="Aplicar sin quitarlo de la lista"
                      disabled={active.stashBusy || active.opState !== null}
                      onClick={() => void doStashApply(active.root, s.index, false)}
                    >
                      Apply
                    </button>
                    <button
                      title="Borrar este stash"
                      disabled={active.stashBusy}
                      onClick={() => void doStashDrop(active.root, s.index)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              {active.status && active.status.entries.length > 0 && (
                <div className="stashbox">
                  <input
                    type="text"
                    placeholder="Mensaje del stash (opcional)"
                    value={active.stashMsg}
                    onChange={(ev) => patchTab(active.root, { stashMsg: ev.target.value })}
                  />
                  <label className="amend">
                    <input
                      type="checkbox"
                      checked={active.stashIncludeUntracked}
                      onChange={(ev) =>
                        patchTab(active.root, { stashIncludeUntracked: ev.target.checked })
                      }
                    />
                    Incluir archivos sin seguir
                  </label>
                  <button
                    className={busyClass(active.stashBusy)}
                    disabled={active.stashBusy || active.opState !== null}
                    onClick={() =>
                      void doStashPush(active.root, active.stashMsg, active.stashIncludeUntracked)
                    }
                  >
                    Guardar stash
                  </button>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {tabs.length === 0 && !openError && (
        <div className="empty">
          <p>Abre un repositorio para empezar.</p>
        </div>
      )}
    </div>
  );
}

export default App;
