import { focusable } from "./a11y";
import { basename } from "./format";
import type { Tab } from "./tabModel";

/** Barra de pestañas de repos: activar, cerrar y reordenar arrastrando. El arrastre
 * (`dragRoot`/`dragOver`) sigue siendo estado de `App`; aquí solo se pinta. */
interface Props {
  tabs: Tab[];
  activeRoot: string | null;
  dragRoot: string | null;
  dragOver: string | null;
  setDragRoot: (root: string | null) => void;
  setDragOver: (root: string | null) => void;
  selectTab: (root: string) => void;
  closeTab: (root: string) => void;
  moveTab: (from: string, to: string) => void;
}

export function TabsBar({ tabs, activeRoot, dragRoot, dragOver, setDragRoot, setDragOver, selectTab, closeTab, moveTab }: Props) {
  return (
    <nav className="tabs" role="tablist" aria-label="Repositorios abiertos">
      {tabs.map((t) => (
        <div
          key={t.root}
          role="tab"
          aria-selected={t.root === activeRoot}
          {...focusable}
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
  );
}
