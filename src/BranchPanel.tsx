import { focusable } from "./a11y";
import type { MenuItem } from "./ContextMenu";
import { branchRef, busyClass } from "./format";
import type { Tab } from "./tabModel";
import type { Branch, Tag } from "./types";

/** Panel izquierdo: ramas locales/remotas, etiquetas, filtro por rama y caja
 * de Rebase / Merge. El estado y las operaciones viven en `App`; aquí solo se
 * pinta. */
interface Props {
  active: Tab;
  menuBusy: boolean;
  openMenu: (ev: React.MouseEvent, heading: string, items: MenuItem[]) => void;
  branchItems: (root: string, b: Branch, blocked: boolean) => MenuItem[];
  tagItems: (root: string, t: Tag) => MenuItem[];
  doCheckout: (root: string, name: string) => Promise<void>;
  doCreateBranch: (root: string, at?: string) => void;
  doMerge: (root: string, branch: Branch) => Promise<void>;
  doRebase: (root: string, onto: string) => Promise<void>;
  applyBranch: (root: string, branch: string | null) => void;
  patchTab: (root: string, patch: Partial<Tab>) => void;
}

export function BranchPanel({ active, menuBusy, openMenu, branchItems, tagItems, doCheckout, doCreateBranch, doMerge, doRebase, applyBranch, patchTab }: Props) {
  return (
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
                    aria-current={b.is_head ? "true" : undefined}
                    {...focusable}
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
                    <button
                      className="link branch-menu"
                      title="Más opciones"
                      aria-label={`Más opciones de ${b.name}`}
                      disabled={menuBusy}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        openMenu(ev, b.name, branchItems(active.root, b, blocked));
                      }}
                    >
                      ⋯
                    </button>
                    {locked && <span className="lock">⊘</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      {active.tags.length > 0 && (
        <div>
          <div className="branch-group-label">Etiquetas</div>
          <ul>
            {active.tags.map((t) => (
              <li
                key={t.name}
                {...focusable}
                className="branch-item"
                title={t.name}
                onContextMenu={(ev) => openMenu(ev, t.name, tagItems(active.root, t))}
              >
                <span className="branch-name">{t.name}</span>
                <button
                  className="link branch-menu"
                  title="Más opciones"
                  aria-label={`Más opciones de ${t.name}`}
                  disabled={menuBusy}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    openMenu(ev, t.name, tagItems(active.root, t));
                  }}
                >
                  ⋯
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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
  );
}
