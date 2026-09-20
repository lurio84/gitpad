// Visor de diff. No intenta ser un editor: colorea las líneas de un
// `git diff`/`git show` tal cual las devuelve la capa Rust. Dos vistas sobre
// el mismo parseo: unificada (una columna, como antes) y side-by-side
// (dos columnas emparejadas, el modo por defecto de Bernardo en GitKraken).

import { useEffect, useState } from "react";
import { wordDiff, type Seg } from "./wordDiff";

type ViewMode = "unified" | "split";

const VIEW_KEY = "gitpad:diff-view";

function loadViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "unified" ? "unified" : "split";
  } catch {
    return "split";
  }
}

type BodyKind = "add" | "del" | "ctx" | "hunk";

interface BodyLine {
  kind: BodyKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  /** Palabras que cambian respecto a su pareja (solo en add/del emparejadas y
   * lo bastante parecidas; sin `+`/`-` inicial). Ver `wordDiff.ts`. */
  segs?: Seg[];
}

interface DiffFile {
  /** Cabecera: `diff --git`, `index`, `---`/`+++`, modo, rename/copy, similarity. */
  header: string[];
  /** "Binary files a/x and b/x differ", si aplica — sin hunks en ese caso. */
  binaryNote: string | null;
  /** Líneas "\ No newline at end of file" encontradas — nota aparte, no entran
   * en el emparejado de columnas para no desincronizar el conteo. */
  notes: string[];
  body: BodyLine[];
}

const HEADER_PREFIXES = [
  "diff ",
  "index ",
  "--- ",
  "+++ ",
  "new file",
  "deleted file",
  "old mode",
  "new mode",
  "rename ",
  "copy ",
  "similarity ",
  "dissimilarity ",
];

const NO_NEWLINE_PREFIX = "\\ No newline";
const BINARY_PREFIX = "Binary files";

function newFile(): DiffFile {
  return { header: [], binaryNote: null, notes: [], body: [] };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parse(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  const ensureFile = (): DiffFile => {
    if (!current) {
      current = newFile();
      files.push(current);
    }
    return current;
  };

  // `git show`/`git diff` terminan su salida con un `\n`; `split("\n")` deja
  // por eso un último elemento "" que no es una línea real. Sin quitarlo se
  // cuela como línea de contexto fantasma (con el `oldLine`/`newLine` que
  // tocara en ese momento), visible en la vista lado a lado como una fila con
  // número de línea suelto.
  const withoutTrailingNewline = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  for (const text of withoutTrailingNewline.split("\n")) {
    if (text.startsWith("diff ")) {
      current = newFile();
      files.push(current);
      inHunk = false;
      current.header.push(text);
      continue;
    }
    const f = ensureFile();
    if (text.startsWith(BINARY_PREFIX)) {
      f.binaryNote = text;
      inHunk = false;
      continue;
    }
    if (!inHunk && HEADER_PREFIXES.some((p) => text.startsWith(p))) {
      f.header.push(text);
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(text);
    if (hunkMatch) {
      inHunk = true;
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      f.body.push({ kind: "hunk", text, oldLine: null, newLine: null });
      continue;
    }
    if (text.startsWith(NO_NEWLINE_PREFIX)) {
      f.notes.push(text);
      continue;
    }
    if (text.startsWith("+")) {
      f.body.push({ kind: "add", text, oldLine: null, newLine: newLine++ });
    } else if (text.startsWith("-")) {
      f.body.push({ kind: "del", text, oldLine: oldLine++, newLine: null });
    } else {
      f.body.push({ kind: "ctx", text, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  const result = files.filter(
    (f) => f.header.length > 0 || f.binaryNote || f.body.length > 0,
  );
  for (const f of result) annotateWords(f.body);
  return result;
}

/** En cada bloque de borradas + añadidas empareja la i-ésima con la i-ésima (el
 * mismo criterio que `pairBody`, para que lo resaltado coincida con lo que la
 * vista lado a lado pone en una misma fila) y marca las palabras que cambian. */
function annotateWords(body: BodyLine[]): void {
  let dels: BodyLine[] = [];
  let adds: BodyLine[] = [];
  const flush = () => {
    const n = Math.min(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = wordDiff(dels[i].text.slice(1), adds[i].text.slice(1));
      if (d) {
        dels[i].segs = d.a;
        adds[i].segs = d.b;
      }
    }
    dels = [];
    adds = [];
  };
  for (const l of body) {
    if (l.kind === "del") {
      if (adds.length > 0) flush();
      dels.push(l);
    } else if (l.kind === "add") {
      adds.push(l);
    } else {
      flush();
    }
  }
  flush();
}

/** Texto de una línea con las palabras cambiadas resaltadas. */
function Segs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.changed ? (
          <span key={i} className="wd">
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

/** Una fila de la vista lado a lado: una mitad puede quedar vacía. */
interface PairedRow {
  left: BodyLine | null;
  right: BodyLine | null;
}

function pairBody(body: BodyLine[]): (PairedRow | { hunk: string })[] {
  const out: (PairedRow | { hunk: string })[] = [];
  let dels: BodyLine[] = [];
  let adds: BodyLine[] = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      out.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };

  for (const line of body) {
    if (line.kind === "hunk") {
      flush();
      out.push({ hunk: line.text });
    } else if (line.kind === "del") {
      dels.push(line);
    } else if (line.kind === "add") {
      adds.push(line);
    } else {
      flush();
      out.push({ left: line, right: line });
    }
  }
  flush();
  return out;
}

interface Props {
  raw: string | null;
  loading: boolean;
  /** Mensaje a mostrar en vez de un diff (p. ej. archivo sin seguir). */
  note?: string;
}

export function DiffView({ raw, loading, note }: Props) {
  const [mode, setMode] = useState<ViewMode>(loadViewMode);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      // localStorage puede fallar (ventana privada, etc.) — no es crítico.
    }
  }, [mode]);

  if (loading)
    return (
      <div className="skeleton diff-skeleton" role="status" aria-label="Cargando diff">
        {[92, 64, 78, 100, 55, 86, 70].map((w, i) => (
          <span key={i} className="skel-bar" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  if (note) return <div className="diff-empty">{note}</div>;
  if (raw === null)
    return <div className="diff-empty">Selecciona un commit o un archivo.</div>;
  if (raw.trim() === "")
    return <div className="diff-empty">Sin cambios que mostrar.</div>;

  const files = parse(raw);

  return (
    <div className="diff-wrap">
      <div className="diff-toolbar">
        <button
          className={mode === "split" ? "on" : ""}
          onClick={() => setMode("split")}
        >
          Side by side
        </button>
        <button
          className={mode === "unified" ? "on" : ""}
          onClick={() => setMode("unified")}
        >
          Unified
        </button>
      </div>
      {mode === "unified" ? (
        <UnifiedView files={files} />
      ) : (
        <SplitView files={files} />
      )}
    </div>
  );
}

function FileNotes({ file }: { file: DiffFile }) {
  return (
    <>
      {file.header.map((h, i) => (
        <div key={`h${i}`} className="dl meta">
          {h}
        </div>
      ))}
      {file.binaryNote && <div className="dl meta">{file.binaryNote}</div>}
      {file.notes.map((n, i) => (
        <div key={`n${i}`} className="dl meta">
          {n}
        </div>
      ))}
    </>
  );
}

function UnifiedView({ files }: { files: DiffFile[] }) {
  return (
    <pre className="diff">
      {files.map((f, fi) => (
        <div key={fi}>
          <FileNotes file={f} />
          {f.body.map((l, i) => (
            <div key={i} className={`dl ${l.kind}`}>
              {l.segs ? (
                <>
                  {l.text[0]}
                  <Segs segs={l.segs} />
                </>
              ) : l.text === "" ? (
                " "
              ) : (
                l.text
              )}
            </div>
          ))}
        </div>
      ))}
    </pre>
  );
}

function SplitView({ files }: { files: DiffFile[] }) {
  return (
    <div className="diff diff-split">
      {files.map((f, fi) => {
        const rows = pairBody(f.body);
        return (
          <div key={fi} className="split-file">
            <FileNotes file={f} />
            {rows.map((r, i) =>
              "hunk" in r ? (
                <div key={i} className="split-row split-hunk">
                  <span className="split-ln" />
                  <span className="split-text">{r.hunk}</span>
                  <span className="split-ln" />
                  <span className="split-text">{r.hunk}</span>
                </div>
              ) : (
                <SplitPair key={i} row={r} />
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

/** `side` decide qué número de línea mostrar en una fila de contexto, que
 * tiene tanto `oldLine` como `newLine` (aparece en ambas columnas a la vez). */
function SplitHalf({ line, side }: { line: BodyLine | null; side: "left" | "right" }) {
  if (!line)
    return (
      <>
        <span className="split-ln" />
        <span className="split-text empty" />
      </>
    );
  const ln = side === "left" ? line.oldLine : line.newLine;
  return (
    <>
      <span className="split-ln">{ln}</span>
      <span className={`split-text ${line.kind}`}>
        {line.segs ? <Segs segs={line.segs} /> : line.text.slice(1) || " "}
      </span>
    </>
  );
}

function SplitPair({ row }: { row: PairedRow }) {
  return (
    <div className="split-row">
      <SplitHalf line={row.left} side="left" />
      <SplitHalf line={row.right} side="right" />
    </div>
  );
}
