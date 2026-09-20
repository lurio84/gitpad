// Visor del contenido de un archivo en un commit («Todos los archivos»). Solo
// texto plano con números de línea, sin resaltado de sintaxis. Dos <pre> en
// vez de un elemento por línea: un archivo de 2 MB son decenas de miles de
// líneas y así siguen siendo dos nodos de DOM.

import type { FileContent } from "./types";

interface Props {
  path: string;
  content: FileContent | null;
  loading: boolean;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileView({ path, content, loading }: Props) {
  if (loading)
    return (
      <div className="skeleton diff-skeleton" role="status" aria-label="Cargando archivo">
        {[92, 64, 78, 100, 55, 86, 70].map((w, i) => (
          <span key={i} className="skel-bar" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  if (!content) return <div className="diff-empty">Selecciona un archivo.</div>;
  if (content.binary)
    return (
      <div className="diff-empty">
        Archivo binario ({humanSize(content.bytes)}) — no se puede mostrar como texto.
      </div>
    );

  const text = content.text ?? "";
  if (text === "") return <div className="diff-empty">Archivo vacío.</div>;

  // Un salto de línea final no abre una línea nueva vacía.
  const lines = text.replace(/\r?\n$/, "").split("\n").length;
  const gutter = Array.from({ length: lines }, (_, i) => i + 1).join("\n");

  return (
    <div className="fileview">
      <div className="fileview-head">
        <span className="fileview-path" title={path}>
          {path}
        </span>
        <span className="fileview-meta">{humanSize(content.bytes)}</span>
      </div>
      {content.truncated && (
        <div className="fileview-note">
          Archivo demasiado grande: se muestra solo el principio (tamaño real{" "}
          {humanSize(content.bytes)}).
        </div>
      )}
      <div className="fileview-body">
        <pre className="fileview-gutter" aria-hidden="true">
          {gutter}
        </pre>
        <pre className="fileview-text">{text}</pre>
      </div>
    </div>
  );
}
