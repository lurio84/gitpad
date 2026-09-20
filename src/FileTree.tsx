// Árbol de archivos plegable a partir de una lista plana de rutas. Lo usan a la
// vez el modo árbol de «Archivos del commit» y el explorador «Todos los
// archivos»: el componente solo agrupa por carpeta y pliega; qué se pinta en
// cada hoja lo decide quien lo usa (`renderLeaf`).

import { useState, type ReactNode } from "react";

export type FilesView = "list" | "tree";

const FILES_VIEW_KEY = "gitpad:files-view";

function loadFilesView(): FilesView {
  try {
    return localStorage.getItem(FILES_VIEW_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

/** Modo lista/árbol persistido (global, no por pestaña), como el del diff. */
export function useFilesView(): [FilesView, (v: FilesView) => void] {
  const [view, setView] = useState<FilesView>(loadFilesView);
  const set = (v: FilesView) => {
    setView(v);
    try {
      localStorage.setItem(FILES_VIEW_KEY, v);
    } catch {
      // localStorage puede fallar (ventana privada, etc.) — no es crítico.
    }
  };
  return [view, set];
}

export function FilesViewToggle({
  view,
  onChange,
}: {
  view: FilesView;
  onChange: (v: FilesView) => void;
}) {
  return (
    <div className="diff-toolbar files-toggle" role="group" aria-label="Vista de archivos">
      <button className={view === "list" ? "on" : ""} onClick={() => onChange("list")}>
        Lista
      </button>
      <button className={view === "tree" ? "on" : ""} onClick={() => onChange("tree")}>
        Árbol
      </button>
    </div>
  );
}

interface DirNode<T> {
  name: string;
  path: string;
  dirs: DirNode<T>[];
  files: { item: T; name: string }[];
}

function buildTree<T>(items: T[], getPath: (t: T) => string): DirNode<T> {
  const root: DirNode<T> = { name: "", path: "", dirs: [], files: [] };
  for (const item of items) {
    const parts = getPath(item).split("/").filter(Boolean);
    const name = parts.pop() ?? "";
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let next = node.dirs.find((d) => d.name === part);
      if (!next) {
        next = { name: part, path: acc, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push({ item, name });
  }
  const sort = (n: DirNode<T>) => {
    n.dirs.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.name.localeCompare(b.name));
    n.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

interface Props<T> {
  items: T[];
  getPath: (item: T) => string;
  /** Si las carpetas arrancan abiertas (true) o plegadas (false). */
  defaultOpen: boolean;
  /** Pinta una hoja. Debe devolver un `<li>`; `depth` sirve para la sangría. */
  renderLeaf: (item: T, name: string, depth: number) => ReactNode;
}

const INDENT = 14;

export function FileTree<T>({ items, getPath, defaultOpen, renderLeaf }: Props<T>) {
  // Solo se guardan las carpetas que el usuario ha invertido respecto al
  // valor por defecto: así el árbol de otro commit no hereda un estado ajeno.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const tree = buildTree(items, getPath);

  const toggle = (path: string) =>
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderDir = (d: DirNode<T>, depth: number): ReactNode => {
    const open = defaultOpen !== flipped.has(d.path);
    return (
      <li key={`d:${d.path}`} className="tree-node">
        <div
          className="tree-dir"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          style={{ paddingLeft: 8 + depth * INDENT }}
          onClick={() => toggle(d.path)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle(d.path);
            }
          }}
        >
          <span className={`tree-caret${open ? " open" : ""}`} aria-hidden="true">
            ▸
          </span>
          <span className="tree-dir-name">{d.name}</span>
        </div>
        {open && renderChildren(d, depth + 1)}
      </li>
    );
  };

  const renderChildren = (n: DirNode<T>, depth: number): ReactNode => (
    <ul className="tree-children">
      {n.dirs.map((d) => renderDir(d, depth))}
      {n.files.map((f) => renderLeaf(f.item, f.name, depth))}
    </ul>
  );

  return <div className="file-tree">{renderChildren(tree, 0)}</div>;
}
