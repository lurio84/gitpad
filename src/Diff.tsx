// Visor de diff unificado. No intenta ser un editor: colorea las líneas de un
// `git diff`/`git show` tal cual las devuelve la capa Rust.

type LineKind = "add" | "del" | "ctx" | "hunk" | "meta";

interface DiffLine {
  kind: LineKind;
  text: string;
}

const META_PREFIXES = [
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
  "Binary files",
  "\\ No newline",
];

function parse(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const text of raw.split("\n")) {
    let kind: LineKind;
    if (text.startsWith("@@")) kind = "hunk";
    else if (META_PREFIXES.some((p) => text.startsWith(p))) kind = "meta";
    else if (text.startsWith("+")) kind = "add";
    else if (text.startsWith("-")) kind = "del";
    else kind = "ctx";
    out.push({ kind, text });
  }
  return out;
}

interface Props {
  raw: string | null;
  loading: boolean;
}

export function DiffView({ raw, loading }: Props) {
  if (loading) return <div className="diff-empty">Cargando diff…</div>;
  if (raw === null)
    return <div className="diff-empty">Selecciona un commit o un archivo.</div>;
  if (raw.trim() === "")
    return <div className="diff-empty">Sin cambios que mostrar.</div>;

  return (
    <pre className="diff">
      {parse(raw).map((l, i) => (
        <div key={i} className={`dl ${l.kind}`}>
          {l.text === "" ? " " : l.text}
        </div>
      ))}
    </pre>
  );
}
