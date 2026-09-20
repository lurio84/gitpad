// Diferencia intra-línea por palabras entre una línea borrada y su pareja
// añadida. Módulo puro (sin React): `Diff.tsx` lo llama al parsear y
// `scripts/test-worddiff.mjs` lo prueba con Node directamente.

export interface Seg {
  text: string;
  changed: boolean;
}

/** Palabras (letras/dígitos/_ de cualquier idioma), blancos y signos sueltos. */
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** Tope de celdas de la tabla LCS (`tokensA × tokensB`). Una línea de un
 * minificado de 100 KB no debe colgar la interfaz: sin resaltado intra-línea,
 * la línea sigue coloreada entera como añadida/borrada. */
export const MAX_CELLS = 250_000;

/** Fracción mínima de texto (sin blancos) compartido para resaltar palabras.
 * Por debajo, las dos líneas son casi otra cosa y marcar "lo cambiado" sería
 * marcar casi todo: ruido, no información. */
export const MIN_SIMILARITY = 0.4;

const nonSpace = (s: string) => s.replace(/\s/g, "").length;

function push(segs: Seg[], text: string, changed: boolean) {
  const last = segs[segs.length - 1];
  if (last && last.changed === changed) last.text += text;
  else segs.push({ text, changed });
}

/**
 * Segmentos de `a` (línea vieja) y de `b` (línea nueva) marcando qué palabras
 * cambian, o `null` si no compensa resaltar (poco parecidas o demasiado
 * largas). Invariante: concatenar los `text` de cada lado devuelve exactamente
 * la cadena original.
 */
export function wordDiff(a: string, b: string): { a: Seg[]; b: Seg[] } | null {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  const n = ta.length;
  const m = tb.length;
  if (n * m > MAX_CELLS) return null;

  // Tabla LCS de atrás hacia delante: `dp[i][j]` = largo de la subsecuencia común
  // de ta[i..] y tb[j..]. Uint16 basta: la LCS no supera min(n, m) ≤ MAX_CELLS.
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        ta[i] === tb[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const sa: Seg[] = [];
  const sb: Seg[] = [];
  let common = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      push(sa, ta[i], false);
      push(sb, tb[j], false);
      if (ta[i].trim() !== "") common += ta[i].length;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      push(sa, ta[i++], true);
    } else {
      push(sb, tb[j++], true);
    }
  }
  while (i < n) push(sa, ta[i++], true);
  while (j < m) push(sb, tb[j++], true);

  const denom = Math.max(nonSpace(a), nonSpace(b), 1);
  if (common / denom < MIN_SIMILARITY) return null;
  return { a: sa, b: sb };
}
