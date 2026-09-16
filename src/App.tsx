import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkoutBranch,
  cherryPick,
  commit as commitRepo,
  fetchRemote,
  getBranches,
  getCommitDiff,
  getCommitFileDiff,
  getCommitFiles,
  getDefaultBase,
  getFileDiff,
  getLog,
  getOpState,
  getStashes,
  getStatus,
  opAbort,
  opContinue,
  openRepo,
  pickRepoFolder,
  pullRemote,
  pushRemote,
  rebaseOnto,
  stagePaths,
  stashApply,
  stashDrop,
  stashPush,
  unstagePaths,
  type LogFilterMode,
} from "./api";
import { DiffView } from "./Diff";
import { Graph } from "./Graph";
import type {
  Branch,
  Commit,
  CommitFile,
  GitError,
  OpState,
  RepoInfo,
  Stash,
  Status,
} from "./types";
import "./App.css";

const LOG_PAGE = 200;
const TABS_KEY = "gitpad:tabs";
const ACTIVE_KEY = "gitpad:active";
const LEGACY_REPO_KEY = "gitpad:last-repo";

/** Qué se está mirando en el panel de diff de una pestaña. */
type Selection =
  | { t: "commit"; hash: string; isMerge?: boolean; file?: string; origPath?: string }
  | { t: "file"; path: string; staged: boolean; untracked?: boolean };

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.t === "commit" && b.t === "commit")
    return a.hash === b.hash && a.file === b.file;
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
  commitMsg: string;
  amend: boolean;
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
  filterMode: LogFilterMode;
  filterQuery: string;
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
    commitMsg: "",
    amend: false,
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
    filterMode: "message",
    filterQuery: "",
    error: null,
    loading: true,
  };
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
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
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  // Abrir un repo resuelve su toplevel antes de crear la pestaña; ese hueco
  // corto no cuelga de ninguna pestaña, así que su estado va aparte.
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // Token de generación POR repo: una carga lenta de una pestaña no puede
  // descartar el resultado fresco de otra (ni el suyo propio si se recarga).
  const gens = useRef<Map<string, number>>(new Map());
  // Filtro de búsqueda aplicado POR repo. Vive en un ref (no en el estado de
  // la pestaña) porque `reload` es estable y no puede leer `tabs` por
  // closure; `reload` lee de aquí, y aplicar un filtro nuevo escribe aquí
  // antes de recargar.
  const filters = useRef<Map<string, { mode: LogFilterMode; query: string }>>(
    new Map(),
  );

  const reload = useCallback(
    async (
      root: string,
      opts?: {
        dropOnError?: boolean;
        filter?: { mode: LogFilterMode; query: string };
      },
    ) => {
      if (opts?.filter) filters.current.set(root, opts.filter);
      const filter = filters.current.get(root) ?? {
        mode: "message" as LogFilterMode,
        query: "",
      };
      const gen = (gens.current.get(root) ?? 0) + 1;
      gens.current.set(root, gen);
      setTabs((ts) =>
        ts.map((t) => (t.root === root ? { ...t, loading: true, error: null } : t)),
      );
      try {
        const info = await openRepo(root);
        const [log, st, branches, opState, stashes, defaultBase] = await Promise.all([
          getLog(info.root, 0, LOG_PAGE, filter.mode, filter.query),
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
    setTabs((ts) =>
      ts.map((t) =>
        t.root === root ? { ...t, sel, diff: null, diffLoading: true } : t,
      ),
    );
    // Un archivo sin seguir, o un commit de fusión (git no da combined diff
    // por defecto), no tienen con qué compararse: no se llama a git.
    if ((sel.t === "file" && sel.untracked) || (sel.t === "commit" && sel.isMerge)) {
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
    async (root: string, hash: string, isMerge: boolean) => {
      if (isMerge) {
        patchTab(root, { commitFiles: [], commitFilesLoading: false });
        return;
      }
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
    try {
      const [opState, status, branches, stashes] = await Promise.all([
        getOpState(root),
        getStatus(root),
        getBranches(root),
        getStashes(root),
      ]);
      patchTab(root, { opState, status, branches, stashes });
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

  const doCommit = useCallback(
    async (root: string, message: string, amend: boolean) => {
      if (!message.trim()) return;
      if (amend && !window.confirm("¿Reescribir el último commit?")) return;
      patchTab(root, { committing: true, error: null });
      try {
        await commitRepo(root, message, amend);
        patchTab(root, { commitMsg: "", committing: false });
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

  const applyFilter = useCallback(
    (root: string, mode: LogFilterMode, query: string) => {
      patchTab(root, { filterMode: mode, filterQuery: query });
      void reload(root, { filter: { mode, query } });
    },
    [reload, patchTab],
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
        setActiveRoot(info.root);
        persistActive(info.root);
        return;
      }
      const next = [...tabs, { ...emptyTab(info.root), info }];
      setTabs(next);
      persistTabs(next);
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
    setActiveRoot(root);
    persistActive(root);
  };

  const closeTab = (root: string) => {
    const idx = tabs.findIndex((t) => t.root === root);
    const next = tabs.filter((t) => t.root !== root);
    gens.current.delete(root);
    setTabs(next);
    persistTabs(next);
    if (activeRoot === root) {
      const neighbour = next[idx] ?? next[next.length - 1] ?? null;
      setActiveRoot(neighbour?.root ?? null);
      persistActive(neighbour?.root ?? null);
    }
  };

  const active = tabs.find((t) => t.root === activeRoot) ?? null;
  const onRefresh = () => {
    if (active) void reload(active.root);
  };

  return (
    <div className="app">
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
            <button onClick={onRefresh} disabled={active.loading}>
              {active.loading ? "…" : "Recargar"}
            </button>
            <button
              onClick={() => void doRemote(active.root, "fetch")}
              disabled={active.remoting !== null}
            >
              {active.remoting === "fetch" ? "…" : "Fetch"}
            </button>
            <button
              onClick={() => void doRemote(active.root, "pull")}
              disabled={active.remoting !== null}
            >
              {active.remoting === "pull" ? "…" : "Pull"}
            </button>
            <button
              onClick={() => void doRemote(active.root, "push")}
              disabled={active.remoting !== null}
            >
              {active.remoting === "push" ? "…" : "Push"}
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
      </header>

      {tabs.length > 0 && (
        <nav className="tabs">
          {tabs.map((t) => (
            <div
              key={t.root}
              className={`tab${t.root === activeRoot ? " active" : ""}`}
              onClick={() => selectTab(t.root)}
              title={t.root}
            >
              <span className="tab-name">{basename(t.root)}</span>
              {t.loading && <span className="tab-spin">…</span>}
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
        <div className="body">
          <aside className="branches">
            <h2>Ramas</h2>
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
                        >
                          {b.is_head && <span className="dot">●</span>}
                          <span className="branch-name">{b.name}</span>
                          {locked && <span className="lock">⊘</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}

            <div className="rebase-box">
              <div className="branch-group-label">Rebase</div>
              <select
                value={active.rebaseTarget}
                disabled={active.rebasing || active.opState !== null}
                onChange={(ev) => patchTab(active.root, { rebaseTarget: ev.target.value })}
              >
                <option value="">Elige una base…</option>
                {Array.from(new Set(active.branches.map((b) => b.name))).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                disabled={
                  active.rebasing || active.opState !== null || !active.rebaseTarget
                }
                onClick={() => void doRebase(active.root, active.rebaseTarget)}
              >
                {active.rebasing ? "…" : "Rebase aquí"}
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
                  disabled={active.opBusy}
                  onClick={() => void doOpContinue(active.root)}
                >
                  {active.opBusy ? "…" : "Continuar"}
                </button>
                <button
                  disabled={active.opBusy}
                  onClick={() => void doOpAbort(active.root)}
                >
                  {active.opBusy ? "…" : "Abortar"}
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
            <div className="commit-list">
              <Graph commits={active.commits} />
              <ol>
                {active.commits.map((c) => {
                  const on =
                    active.sel?.t === "commit" && active.sel.hash === c.hash;
                  const isMerge = c.parents.length > 1;
                  return (
                    <li
                      key={c.hash}
                      className={`commit${on ? " sel" : ""}`}
                      onClick={() => {
                        // Reclicar el commit ya seleccionado lo deselecciona:
                        // es la única forma de volver al panel "Cambios" (para
                        // preparar/sacar archivos) sin cerrar la pestaña.
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
                        void loadCommitFiles(active.root, c.hash, isMerge);
                      }}
                    >
                      <div className="commit-line">
                        {c.refs.map((r, i) => (
                          <span key={`${i}-${r}`} className="ref">
                            {r}
                          </span>
                        ))}
                        <span className="subject">{c.subject}</span>
                      </div>
                      <div className="commit-meta">
                        <code>{c.short_hash}</code>
                        <span>{c.author_name}</span>
                        <span>{new Date(c.date).toLocaleString()}</span>
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
            {active.commits.length === LOG_PAGE && (
              <p className="more">Mostrando los primeros {LOG_PAGE} commits.</p>
            )}
          </section>

          <section className="diffpane">
            <DiffView
              raw={active.diff}
              loading={active.diffLoading}
              note={
                active.sel?.t === "file" && active.sel.untracked
                  ? "Archivo sin seguir — todavía no hay nada que comparar."
                  : active.sel?.t === "commit" && active.sel.isMerge
                    ? "Commit de merge — sin diff propio; mira los commits que mergea."
                    : undefined
              }
            />
          </section>

          <aside className="status">
            {active.sel?.t === "commit" ? (
              <>
                <h2>Archivos del commit</h2>
                {active.commitFilesLoading && <p className="clean">Cargando…</p>}
                {!active.commitFilesLoading && active.sel.isMerge && (
                  <p className="clean">
                    Commit de merge — sin lista propia de archivos.
                  </p>
                )}
                {!active.commitFilesLoading &&
                  !active.sel.isMerge &&
                  active.commitFiles.length === 0 && (
                    <p className="clean">Sin archivos.</p>
                  )}
                <ul>
                  {!active.commitFilesLoading &&
                    !active.sel.isMerge &&
                    active.commitFiles.map((cf) => {
                      const sel = active.sel;
                      const on = sel?.t === "commit" && sel.file === cf.path;
                      return (
                        <li
                          key={cf.path}
                          className={`entry${on ? " sel" : ""}`}
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
                          <span className="path">
                            {cf.orig_path ? `${cf.orig_path} → ${cf.path}` : cf.path}
                          </span>
                        </li>
                      );
                    })}
                </ul>
              </>
            ) : (
              <>
                <h2>Cambios</h2>
                {active.status && active.status.entries.length === 0 && (
                  <p className="clean">Árbol de trabajo limpio</p>
                )}
                <ul>
                  {active.status?.entries.map((e) => {
                const hasStaged = e.staged !== ".";
                // "?" (sin seguir) no tiene diff contra el índice, pero sí se
                // puede preparar.
                const untracked = e.unstaged === "?";
                const hasUnstaged = e.unstaged !== "." && !untracked;
                const rowStaged = !hasUnstaged && hasStaged;
                const selOn = (s: boolean) =>
                  active.sel?.t === "file" &&
                  active.sel.path === e.path &&
                  active.sel.staged === s;
                const pick = (s: boolean) =>
                  void loadDiff(active.root, {
                    t: "file",
                    path: e.path,
                    staged: s,
                    untracked,
                  });
                return (
                  <li
                    key={e.path}
                    className={`entry ${e.kind}${
                      selOn(true) || selOn(false) ? " sel" : ""
                    }`}
                    onClick={() => pick(rowStaged)}
                  >
                    <span className="xy">
                      <span
                        className={`xc${hasStaged ? " hit" : ""}${
                          selOn(true) ? " on" : ""
                        }`}
                        onClick={(ev) => {
                          if (!hasStaged) return;
                          ev.stopPropagation();
                          pick(true);
                        }}
                      >
                        {e.staged}
                      </span>
                      <span
                        className={`xc${hasUnstaged ? " hit" : ""}${
                          selOn(false) ? " on" : ""
                        }`}
                        onClick={(ev) => {
                          if (!hasUnstaged) return;
                          ev.stopPropagation();
                          pick(false);
                        }}
                      >
                        {e.unstaged}
                      </span>
                    </span>
                    <span className="path">
                      {e.orig_path ? `${e.orig_path} → ${e.path}` : e.path}
                    </span>
                    <span className="stagebtns">
                      {(hasUnstaged || untracked) && (
                        <button
                          title="Stage"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void toggleStage(active.root, [e.path], true);
                          }}
                        >
                          ＋
                        </button>
                      )}
                      {hasStaged && (
                        <button
                          title="Unstage"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void toggleStage(active.root, [e.path], false);
                          }}
                        >
                          －
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
                </ul>
              </>
            )}

            {active.status && active.status.entries.some((e) => e.staged !== ".") && (
              <form
                className="commitbox"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void doCommit(active.root, active.commitMsg, active.amend);
                }}
              >
                <textarea
                  placeholder="Mensaje del commit"
                  value={active.commitMsg}
                  rows={3}
                  onChange={(ev) =>
                    patchTab(active.root, { commitMsg: ev.target.value })
                  }
                />
                <label className="amend">
                  <input
                    type="checkbox"
                    checked={active.amend}
                    onChange={(ev) =>
                      patchTab(active.root, { amend: ev.target.checked })
                    }
                  />
                  Reescribir el último (amend)
                </label>
                <button
                  type="submit"
                  disabled={
                    active.committing || !active.commitMsg.trim() || active.opState !== null
                  }
                >
                  {active.committing ? "…" : active.amend ? "Amend" : "Commit"}
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
                    disabled={active.stashBusy || active.opState !== null}
                    onClick={() =>
                      void doStashPush(active.root, active.stashMsg, active.stashIncludeUntracked)
                    }
                  >
                    {active.stashBusy ? "…" : "Guardar stash"}
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
