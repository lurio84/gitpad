import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkoutBranch,
  cherryPick,
  commit as commitRepo,
  createBranch,
  createTag,
  deleteBranch,
  deleteRemoteTag,
  deleteTag,
  discardPaths,
  fetchBranch,
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
  getTags,
  getTreeFiles,
  opAbort,
  opContinue,
  mergeBranch,
  openRepo,
  pickRepoFolder,
  pullRemote,
  pushBranch,
  pushNewBranch,
  pushRemote,
  pushTagRemote,
  rebaseOnto,
  renameBranch,
  resetTo,
  revertCommit,
  stagePaths,
  stashApply,
  stashDrop,
  stashPush,
  unstagePaths,
  type LogFilterMode,
  type ResetMode,
} from "./api";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { focusable, listRow } from "./a11y";
import { DiffView } from "./Diff";
import { FilesViewToggle, FileTree, leafIndent, useFilesView } from "./FileTree";
import { FileView } from "./FileView";
import { Graph, ROW_H, WIP_HASH } from "./Graph";
import { usePanels } from "./usePanels";
import { BranchPanel } from "./BranchPanel";
import { TabsBar } from "./TabsBar";
import { basename, branchLabel, branchRef, busyClass, isGitError, shortDate, wipCommit } from "./format";
import {
  ACTIVE_KEY,
  DEFAULT_VIEW,
  emptyTab,
  LOG_PAGE,
  persistActive,
  persistTabs,
  restoreRoots,
  sameSelection,
  type LogView,
  type Selection,
  type Tab,
} from "./tabModel";
import type { Branch, Commit, CommitFile, StatusEntry, Tag } from "./types";
import "./App.css";

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  // Espejo síncrono de `tabs` para código que necesita leer el estado actual
  // sin esperar al próximo render (p. ej. `reload` decidiendo qué hacer con
  // `sel` antes de llamar a `loadDiff`, fuera del updater de `setTabs`).
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  const [filesView, setFilesView] = useFilesView();
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  // Sin nada seleccionado (ni commit ni archivo de "Cambios") la columna de
  // diff no tiene qué mostrar: se colapsa y la lista de commits ocupa su
  // sitio. Se mira `tabs`/`activeRoot` directamente (no la `active` de más
  // abajo) porque usePanels necesita esto antes en el render.
  const diffCollapsed = (tabs.find((t) => t.root === activeRoot)?.sel ?? null) === null;
  const panels = usePanels(diffCollapsed);
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
        const [log, st, branches, tags, opState, stashes, defaultBase] = await Promise.all([
          getLog(info.root, 0, filter.limit, filter.mode, filter.query, filter.branch, filter.file),
          getStatus(info.root),
          getBranches(info.root),
          getTags(info.root),
          getOpState(info.root),
          getStashes(info.root),
          getDefaultBase(info.root),
        ]);
        if (gens.current.get(root) !== gen) return;
        // La selección sobrevive a la recarga si sigue teniendo sentido: un
        // commit se mantiene si sigue en el log (es inmutable, no hace falta
        // recargar su diff); un archivo se sigue al lado (staged/unstaged) en
        // el que aparezca ahora, y se pierde solo si ya no está en absoluto
        // (se descartó, se commiteó, etc.). Sin esto cada stage/commit/pull
        // colapsaba el centro y volvía a expandirlo al reseleccionar.
        // Se lee de `tabsRef` (no del updater de `setTabs`, que puede correr
        // más tarde durante el render) porque hace falta decidir YA si hay
        // que llamar a `loadDiff` a continuación.
        const prevSel = tabsRef.current.find((t) => t.root === root)?.sel ?? null;
        let sel = prevSel;
        if (sel !== null && sel.t === "commit") {
          const hash = sel.hash;
          if (!log.some((c) => c.hash === hash)) sel = null;
        } else if (sel !== null && sel.t === "file") {
          const path = sel.path;
          const staged = sel.staged;
          const entry = st.entries.find((e) => e.path === path);
          if (!entry) {
            sel = null;
          } else if (staged) {
            sel =
              entry.staged !== "."
                ? sel
                : entry.unstaged !== "."
                  ? { t: "file", path: entry.path, staged: false, untracked: entry.unstaged === "?" }
                  : null;
          } else {
            sel =
              entry.unstaged !== "."
                ? { t: "file", path: entry.path, staged: false, untracked: entry.unstaged === "?" }
                : entry.staged !== "."
                  ? { t: "file", path: entry.path, staged: true }
                  : null;
          }
        }
        const finalSel = sel;
        setTabs((ts) =>
          ts.map((t) =>
            t.root === root
              ? {
                  ...t,
                  info,
                  commits: log,
                  filterBranch: filter.branch,
                  filterFile: filter.file,
                  logLimit: filter.limit,
                  branches,
                  tags,
                  status: st,
                  opState,
                  stashes,
                  // Solo se precarga una vez; si Bernardo ya eligió otra base
                  // no se le pisa en cada recarga.
                  rebaseTarget: t.rebaseTarget || defaultBase || "",
                  loading: false,
                  error: null,
                  sel: finalSel,
                  // El diff de un commit no cambia; el de un archivo sí puede
                  // (por eso se vuelve a pedir abajo), así que se limpia aquí
                  // y loadDiff lo repone.
                  diff: finalSel?.t === "commit" ? t.diff : null,
                  diffLoading: false,
                }
              : t,
          ),
        );
        // El archivo seguía seleccionado (quizá cambió de lado): su diff hay
        // que volver a pedirlo, el de working tree/staged puede ser distinto.
        if (finalSel?.t === "file") void loadDiff(root, finalSel);
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
        t.root === root ? { ...t, treeHash: hash, treeLoading: true, treePaths: [], treeTotal: 0 } : t,
      ),
    );
    try {
      const tree = await getTreeFiles(root, hash);
      setTabs((ts) =>
        ts.map((t) =>
          t.root === root && t.treeHash === hash
            ? { ...t, treePaths: tree.paths, treeTotal: tree.total, treeLoading: false }
            : t,
        ),
      );
    } catch (e) {
      const msg = isGitError(e) ? e.message : String(e);
      setTabs((ts) =>
        ts.map((t) =>
          t.root === root && t.treeHash === hash
            ? { ...t, treePaths: [], treeTotal: 0, treeLoading: false, error: msg }
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
      const [info, opState, status, branches, tags, stashes, log] = await Promise.all([
        // Sin esto `head_hash` queda obsoleto tras un commit hecho fuera de
        // gitpad: el nodo //WIP se dibujaría enganchado al HEAD viejo (se
        // saltaría el commit más nuevo) justo en el camino que existe para
        // esto — volver de un alt-tab tras commitear desde otra herramienta.
        openRepo(root),
        getOpState(root),
        getStatus(root),
        getBranches(root),
        getTags(root),
        getStashes(root),
        // `filter.limit`, no LOG_PAGE: si Bernardo ya cargó más páginas, un
        // alt-tab no debe encogerle la lista.
        getLog(root, 0, filter.limit, filter.mode, filter.query, filter.branch, filter.file),
      ]);
      if (gens.current.get(root) !== gen) return;
      patchTab(root, { info, opState, status, branches, tags, stashes, commits: log });
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
      // Los botones por fila aparecen al pasar el ratón: fácil pulsar el de la fila
      // equivocada. La confirmación dice CUÁL(ES) se pierde(n).
      const nombres = paths.slice(0, 6).map((p) => `  • ${p}`);
      if (paths.length > 6) nombres.push(`  … y ${paths.length - 6} más`);
      const que = paths.length === 1 ? "este archivo" : "estos archivos";
      const msg =
        (untracked
          ? `¿Borrar ${que} sin seguir?`
          : `¿Descartar los cambios de ${que}?`) +
        `\n\n${nombres.join("\n")}\n\nNo se puede deshacer.`;
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

  const doRevert = useCallback(
    async (root: string, c: Commit) => {
      if (!window.confirm(`¿Crear un commit que deshaga ${c.short_hash} «${c.subject}»?`)) return;
      patchTab(root, { refBusy: true, error: null });
      try {
        await revertCommit(root, c.hash);
        patchTab(root, { refBusy: false });
        await reload(root);
      } catch (e) {
        // Un conflicto deja el revert a medias: refrescar para que aparezca el banner.
        failTab(root, e);
        await refreshVolatile(root);
      }
    },
    [reload, patchTab, failTab, refreshVolatile],
  );

  /** `lost`: cambios sin guardar que hay AHORA; solo importan con `hard`, que los descarta. */
  const doReset = useCallback(
    (root: string, c: Commit, mode: ResetMode, branch: string | null, lost: StatusEntry[]) => {
      let msg =
        `¿Mover ${branch ? `la rama "${branch}"` : "HEAD"} a ${c.short_hash} «${c.subject}»?\n\n` +
        "Los commits posteriores dejarán de estar en la rama (siguen en el reflog).";
      if (mode === "soft") msg += "\n\nSus cambios quedan preparados (staged).";
      if (mode === "mixed") msg += "\n\nSus cambios quedan en tu carpeta, sin preparar.";
      if (mode === "hard") {
        const nombres = lost.slice(0, 8).map((e) => `  • ${e.path}`);
        if (lost.length > 8) nombres.push(`  … y ${lost.length - 8} más`);
        msg +=
          lost.length > 0
            ? `\n\nSE PERDERÁN los cambios sin guardar de ${lost.length} archivo(s):\n${nombres.join("\n")}`
            : "\n\nNo hay cambios sin guardar que perder.";
        msg += "\n(Los archivos sin seguir no se tocan.)";
      }
      if (!window.confirm(msg)) return;
      void refOp(root, () => resetTo(root, c.hash, mode));
    },
    [refOp],
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
    (root: string, name: string, hasRemote: boolean) => {
      if (!window.confirm(`¿Borrar el tag "${name}"? Solo el local; el remoto no se toca.`)) return;
      // Una vez borrado el local, `list_tags` ya no lo trae y el menú de este
      // tag (con "Borrar del remoto…") deja de ser alcanzable. Se ofrece
      // aquí mismo, antes de que desaparezca de la lista. Sin remoto
      // configurado no tiene sentido preguntar (fallaría siempre).
      const alsoRemote = hasRemote && window.confirm(`¿Borrar "${name}" también del remoto?`);
      void refOp(root, async () => {
        await deleteTag(root, name);
        if (!alsoRemote) return;
        // El borrado local ya pasó: si el remoto falla, se recarga IGUAL
        // (para que la lista no se quede con un tag que ya no existe local)
        // y luego se relanza, para que el error se vea.
        try {
          await deleteRemoteTag(root, name);
        } catch (e) {
          await reload(root);
          throw e;
        }
      });
    },
    [refOp, reload],
  );

  // Pull/push de una rama LOCAL que no es la activa (la activa sigue usando
  // doRemote/los botones de la topbar, sin cambios). `remote`/`remoteRef`
  // vienen de `Branch.upstream_remote`/`upstream_ref`: nunca se reconstruyen
  // a mano (una rama puede trackear una remota de otro nombre).
  const doFetchBranch = useCallback(
    (root: string, b: Branch) => {
      if (!b.upstream_remote || !b.upstream_ref) return;
      void refOp(root, () => fetchBranch(root, b.name, b.upstream_remote!, b.upstream_ref!));
    },
    [refOp],
  );

  const doPushBranch = useCallback(
    (root: string, b: Branch) => {
      void refOp(root, () =>
        b.upstream_remote && b.upstream_ref
          ? pushBranch(root, b.name, b.upstream_remote, b.upstream_ref)
          : pushNewBranch(root, b.name),
      );
    },
    [refOp],
  );

  const doPushTagRemote = useCallback(
    (root: string, name: string) => {
      void refOp(root, () => pushTagRemote(root, name));
    },
    [refOp],
  );

  const doDeleteRemoteTag = useCallback(
    (root: string, name: string) => {
      if (!window.confirm(`¿Borrar el tag "${name}" del remoto? El local no se toca.`)) return;
      void refOp(root, () => deleteRemoteTag(root, name));
    },
    [refOp],
  );

  const applyFilter = useCallback(
    (root: string, mode: LogFilterMode, query: string) => {
      // Buscar deja el lente de archivo: los dos no se combinan.
      patchTab(root, { filterMode: mode, filterQuery: query, filterFile: null });
      void reload(root, { filter: { mode, query, file: null } });
    },
    [reload, patchTab],
  );

  /** Historial de un archivo (lente pasajero, como el de rama y sin persistir):
   * con `null` vuelve al log normal. Suelta la búsqueda en curso. */
  const applyFile = useCallback(
    (root: string, file: string | null) => {
      patchTab(root, { filterFile: file, filterQuery: "" });
      void reload(root, { filter: { file, query: "" } });
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
        const log = await getLog(root, 0, limit, view.mode, view.query, view.branch, view.file);
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
    // Con el historial de un archivo el //WIP no pinta nada: no es un commit del archivo.
    !active.filterFile &&
    (!active.filterBranch || active.filterBranch === `refs/heads/${active.info.head}`)
  );
  const displayCommits =
    showWip && active
      ? [wipCommit(active.info!.head_hash!), ...active.commits]
      : (active?.commits ?? []);

  const openMenu = (ev: React.MouseEvent, heading: string, items: MenuItem[]) => {
    ev.preventDefault();
    ev.stopPropagation();
    // Un clic activado por teclado (Enter/Espacio en el botón "⋯") llega con
    // clientX/Y en 0: se posiciona con el rect del propio elemento en vez de
    // clavar el menú en la esquina.
    if (ev.clientX === 0 && ev.clientY === 0) {
      const r = ev.currentTarget.getBoundingClientRect();
      setMenu({ x: r.left, y: r.bottom, heading, items });
      return;
    }
    setMenu({ x: ev.clientX, y: ev.clientY, heading, items });
  };
  // Con una operación a medias (conflicto) o en marcha solo quedan vivos
  // Continuar/Abortar del banner: el resto de acciones del menú se apagan.
  // `remoting` cuenta: sin esto, un fetch/pull/push de la topbar (rama
  // activa) y una operación de red por rama/tag del menú podían correr a la
  // vez sobre el mismo repo.
  const menuBusy =
    !!active && (active.opState !== null || active.refBusy || active.rebasing || active.remoting !== null);
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
          {
            label: "Pull",
            // La activa reutiliza doRemote (topbar); una bloqueada por otro
            // worktree la rechazaría igual que a fetch --branch:branch.
            disabled: menuBusy || blocked || (!b.is_head && !b.upstream_ref),
            title: !b.is_head && !b.upstream_ref ? "Sin upstream configurado" : undefined,
            onSelect: () =>
              b.is_head ? void doRemote(root, "pull") : doFetchBranch(root, b),
          },
          {
            label: "Push",
            disabled: menuBusy || blocked,
            onSelect: () =>
              b.is_head ? void doRemote(root, "push") : doPushBranch(root, b),
          },
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
  // Solo salta al commit si está en la lista ya cargada (sin filtro/paginación
  // de por medio); si no, el ítem del menú sale deshabilitado.
  const goToCommit = (root: string, hash: string) => {
    const c = active?.commits.find((x) => x.hash === hash);
    if (!c) return;
    void loadDiff(root, { t: "commit", hash: c.hash, isMerge: c.parents.length > 1 });
    void loadCommitFiles(root, c.hash);
  };
  const tagItems = (root: string, t: Tag): MenuItem[] => [
    {
      label: "Ir al commit",
      disabled: !active?.commits.some((c) => c.hash === t.target),
      title: !active?.commits.some((c) => c.hash === t.target)
        ? "No está en la lista de commits cargada"
        : undefined,
      onSelect: () => goToCommit(root, t.target),
    },
    {
      label: "Borrar…",
      danger: true,
      disabled: menuBusy,
      onSelect: () => doDeleteTag(root, t.name, active?.branches.some((b) => b.is_remote) ?? false),
    },
    {
      label: "Subir al remoto",
      disabled: menuBusy,
      onSelect: () => doPushTagRemote(root, t.name),
    },
    {
      label: "Borrar del remoto…",
      danger: true,
      disabled: menuBusy,
      // No exige que el tag exista local: se puede borrar del remoto
      // después de borrarlo aquí, o sin haberlo tenido nunca local.
      onSelect: () => doDeleteRemoteTag(root, t.name),
    },
  ];
  const commitItems = (root: string, c: Commit): MenuItem[] => {
    const esMerge = c.parents.length > 1;
    // Lo que `reset --hard` descartaría ahora: cambios en archivos seguidos (los
    // sin seguir y los ignorados sobreviven).
    const perdibles = (active?.status?.entries ?? []).filter(
      (e) => e.kind !== "untracked" && e.kind !== "ignored",
    );
    const rama = active?.info?.head ?? null;
    const reset = (mode: ResetMode) => () => doReset(root, c, mode, rama, perdibles);
    return [
      { label: "Crear rama aquí…", disabled: menuBusy, onSelect: () => doCreateBranch(root, c.hash) },
      { label: "Crear tag aquí…", disabled: menuBusy, onSelect: () => doCreateTag(root, c.hash) },
      {
        label: "Revert de este commit…",
        disabled: menuBusy || esMerge,
        title: esMerge
          ? "Un commit de fusión no se puede revertir desde gitpad"
          : "Crea un commit nuevo que deshace este (no reescribe historia)",
        onSelect: () => void doRevert(root, c),
      },
      {
        label: "Reset soft a este commit…",
        disabled: menuBusy,
        title: "Mueve la rama aquí; los cambios quedan preparados (staged)",
        onSelect: reset("soft"),
      },
      {
        label: "Reset mixed a este commit…",
        disabled: menuBusy,
        title: "Mueve la rama aquí; los cambios quedan en tu carpeta, sin preparar",
        onSelect: reset("mixed"),
      },
      {
        label: "Reset hard a este commit…",
        danger: true,
        disabled: menuBusy,
        title: "Mueve la rama aquí y DESCARTA los cambios sin guardar",
        onSelect: reset("hard"),
      },
    ];
  };
  const fileItems = (root: string, path: string): MenuItem[] => [
    {
      label: "Ver historial de este archivo",
      disabled: menuBusy,
      onSelect: () => applyFile(root, path),
    },
  ];

  // Una sola parada de Tab en la lista de commits (ver `listRow`): el seleccionado,
  // o el primero si no hay ninguno visible.
  const selHash = active?.sel?.t === "commit" ? active.sel.hash : null;
  const selVisible = selHash !== null && displayCommits.some((x) => x.hash === selHash);

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
              disabled={active.remoting !== null || active.refBusy}
            >
              Fetch
            </button>
            <button
              className={busyClass(active.remoting === "pull")}
              onClick={() => void doRemote(active.root, "pull")}
              disabled={active.remoting !== null || active.refBusy}
            >
              Pull
            </button>
            <button
              className={busyClass(active.remoting === "push")}
              onClick={() => void doRemote(active.root, "push")}
              disabled={active.remoting !== null || active.refBusy}
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
        <button
          className="about-btn"
          title="Acerca de gitpad"
          aria-label="Acerca de gitpad"
          onClick={() =>
            window.alert(`gitpad v${__APP_VERSION__}\ngithub.com/lurio84/gitpad`)
          }
        >
          ⓘ
        </button>
      </header>

      {tabs.length > 0 && (
        <TabsBar
          tabs={tabs}
          activeRoot={activeRoot}
          selectTab={selectTab}
          closeTab={closeTab}
          moveTab={moveTab}
        />
      )}

      {openError && <div className="error">{openError}</div>}
      {/* Con una operación en curso, el banner de conflicto (abajo, en
          `.commits`) ya explica qué hacer — el error crudo de git detrás
          (hints en inglés) solo añade ruido para alguien no técnico. */}
      {active?.error && !active.opState && <div className="error">{active.error}</div>}

      {active && (
        <div
          className={`body${diffCollapsed ? " diff-collapsed" : ""}`}
          ref={panels.bodyRef}
          style={panels.style}
        >
          <div {...panels.handleProps("left")} />
          <div {...panels.handleProps("right")} />
          <BranchPanel
            active={active}
            menuBusy={menuBusy}
            openMenu={openMenu}
            branchItems={branchItems}
            tagItems={tagItems}
            doCheckout={doCheckout}
            doCreateBranch={doCreateBranch}
            doMerge={doMerge}
            doRebase={doRebase}
            applyBranch={applyBranch}
            patchTab={patchTab}
          />

          <section className="commits">
            {active.opState && (
              <p className="conflict-banner">
                {active.opState.kind === "rebase" && "Rebase en curso"}
                {active.opState.kind === "cherry_pick" && "Cherry-pick en curso"}
                {active.opState.kind === "merge" && "Merge en curso"}
                {active.opState.kind === "revert" && "Revert en curso"}
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
            {active.filterFile && (
              <p className="filter-info">
                Historial de <strong>{active.filterFile}</strong> ·{" "}
                {/* Sin recuento mientras carga: la lista aún es la de antes del filtro. */}
                {active.loading
                  ? "cargando…"
                  : `${active.commits.length} ${active.commits.length === 1 ? "commit" : "commits"}`}{" "}
                ·{" "}
                <button className="link" onClick={() => applyFile(active.root, null)}>
                  ver todo
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
            {!active.loading && displayCommits.length === 0 && (
              <p className="clean empty-log">
                {active.filterQuery.trim() || active.filterBranch || active.filterFile
                  ? "Ningún commit coincide con el filtro."
                  : "Este repo aún no tiene commits."}
              </p>
            )}
            <div className={`commit-list${introOn ? " intro" : ""}`}>
              {/* Con el historial de un archivo `%P` trae los padres reales, que casi
                  nunca están en la lista filtrada: dibujar líneas hacia ellos fingiría
                  una topología que la lista no tiene. Sin padres, el grafo queda como
                  una columna de puntos (la lista sí conserva los padres: merges). */}
              <Graph
                commits={
                  active.filterFile
                    ? displayCommits.map((c) => ({ ...c, parents: [] }))
                    : displayCommits
                }
              />
              <ol>
                {displayCommits.map((c, idx) => {
                  if (c.hash === WIP_HASH) {
                    // Entrada al panel "Cambios": mismo gesto que en
                    // GitKraken (clicar el nodo //WIP), en vez de depender de
                    // reclicar el commit ya seleccionado.
                    const wipOn = active.sel === null;
                    return (
                      <li
                        key="wip"
                        aria-current={wipOn ? "true" : undefined}
                        {...listRow(!selVisible)}
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
                      aria-current={on ? "true" : undefined}
                      {...listRow(selVisible ? c.hash === selHash : idx === 0)}
                      className={`commit${on ? " sel" : ""}`}
                      onContextMenu={(ev) =>
                        // El nodo //WIP no es un commit real: sin menú (y sin el nativo).
                        c.hash === WIP_HASH
                          ? ev.preventDefault()
                          : openMenu(ev, `${c.short_hash} ${c.subject}`, commitItems(active.root, c))
                      }
                      onClick={(ev) => {
                        // Reclicar el commit ya seleccionado lo deselecciona:
                        // vuelve al panel "Cambios" (lo mismo que clicar el
                        // nodo //WIP, cuando lo hay). Ctrl/Cmd+clic deselecciona
                        // desde cualquier commit, sin tener que reclicar el activo.
                        if (on || ev.ctrlKey || ev.metaKey) {
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
                                        onSelect: () =>
                                          doDeleteTag(
                                            active.root,
                                            r.name,
                                            active.branches.some((b) => b.is_remote),
                                          ),
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
                  <>
                  {active.treeTotal > active.treePaths.length && (
                    <p className="clean" role="status">
                      Mostrando {active.treePaths.length.toLocaleString("es-ES")} de{" "}
                      {active.treeTotal.toLocaleString("es-ES")} archivos.
                    </p>
                  )}
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
                            aria-current={on ? "true" : undefined}
                            {...focusable}
                            className={`entry${on ? " sel" : ""}`}
                            style={{ paddingLeft: leafIndent(depth) }}
                            onContextMenu={(ev) => openMenu(ev, p, fileItems(active.root, p))}
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
                  </>
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
                        aria-current={on ? "true" : undefined}
                        {...focusable}
                        className={`entry${on ? " sel" : ""}`}
                        style={
                          filesView === "tree" ? { paddingLeft: leafIndent(depth) } : undefined
                        }
                        onContextMenu={(ev) =>
                          openMenu(ev, cf.path, fileItems(active.root, cf.path))
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
                                {...focusable}
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
                          <li className="clean-row">Nada sin preparar</li>
                        )}
                        {unstagedEntries.map((e) => {
                          const untracked = e.unstaged === "?";
                          return (
                            <li
                              key={`u-${e.path}`}
                              {...focusable}
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
                        {stagedEntries.length === 0 && <li className="clean-row">Nada preparado</li>}
                        {stagedEntries.map((e) => (
                          <li
                            key={`s-${e.path}`}
                            {...focusable}
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
                  onKeyDown={(ev) => {
                    // Ctrl+Enter commitea: mismo destino y misma guarda que el
                    // botón, así no hace falta soltar el textarea para enviar.
                    if (
                      ev.key === "Enter" &&
                      (ev.ctrlKey || ev.metaKey) &&
                      !active.committing &&
                      active.commitSubject.trim() &&
                      active.opState === null
                    ) {
                      ev.preventDefault();
                      void doCommit(
                        active.root,
                        active.commitSubject,
                        active.commitBody,
                        active.amend,
                      );
                    }
                  }}
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
