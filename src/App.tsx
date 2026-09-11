import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkoutBranch,
  commit as commitRepo,
  getBranches,
  getCommitDiff,
  getFileDiff,
  getLog,
  getStatus,
  openRepo,
  pickRepoFolder,
  stagePaths,
  unstagePaths,
  type LogFilterMode,
} from "./api";
import { DiffView } from "./Diff";
import { Graph } from "./Graph";
import type { Branch, Commit, GitError, RepoInfo, Status } from "./types";
import "./App.css";

const LOG_PAGE = 200;
const TABS_KEY = "gitpad:tabs";
const ACTIVE_KEY = "gitpad:active";
const LEGACY_REPO_KEY = "gitpad:last-repo";

/** Qué se está mirando en el panel de diff de una pestaña. */
type Selection =
  | { t: "commit"; hash: string; isMerge?: boolean }
  | { t: "file"; path: string; staged: boolean; untracked?: boolean };

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.t === "commit" && b.t === "commit") return a.hash === b.hash;
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
  commitMsg: string;
  amend: boolean;
  committing: boolean;
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
    commitMsg: "",
    amend: false,
    committing: false,
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
        const [log, st, branches] = await Promise.all([
          getLog(info.root, 0, LOG_PAGE, filter.mode, filter.query),
          getStatus(info.root),
          getBranches(info.root),
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
          ? await getCommitDiff(root, sel.hash)
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

  const patchTab = useCallback((root: string, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.root === root ? { ...t, ...patch } : t)));
  }, []);

  const failTab = useCallback(
    (root: string, e: unknown) => {
      patchTab(root, {
        error: isGitError(e) ? e.message : String(e),
        committing: false,
      });
    },
    [patchTab],
  );

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
      {active?.error && <div className="error">{active.error}</div>}

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
                      return (
                        <li
                          key={b.name}
                          className={`branch-item${b.is_head ? " current" : ""}${
                            locked ? " locked" : ""
                          }`}
                          title={
                            locked
                              ? `Abierta en otro worktree: ${b.worktree_path}`
                              : b.name
                          }
                          onClick={() =>
                            !locked && void doCheckout(active.root, b.checkout_arg)
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
          </aside>

          <section className="commits">
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
                      onClick={() =>
                        void loadDiff(active.root, {
                          t: "commit",
                          hash: c.hash,
                          isMerge,
                        })
                      }
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
                    ? "Commit de fusión — sin diff propio; mira los commits que fusiona."
                    : undefined
              }
            />
          </section>

          <aside className="status">
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
                          title="Preparar"
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
                          title="Sacar del índice"
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
                  disabled={active.committing || !active.commitMsg.trim()}
                >
                  {active.committing ? "…" : active.amend ? "Amend" : "Commit"}
                </button>
              </form>
            )}
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
