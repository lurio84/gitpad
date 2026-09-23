// Anchos de los dos paneles laterales (ramas a la izquierda, commit/cambios a
// la derecha), arrastrables. Se guarda el ancho PREFERIDO; el efectivo se
// calcula en cada render contra el ancho de la ventana. Así un ancho guardado
// a 1920 px no rompe la app abierta a 1000 px, ni al achicar la ventana: el
// panel central del diff nunca baja de su mínimo, pase lo que pase.

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

const PANELS_KEY = "gitpad:panels";

export type Side = "left" | "right";

interface Widths {
  left: number;
  right: number;
}

export const DEFAULTS: Widths = { left: 180, right: 280 };
const MIN: Widths = { left: 140, right: 220 };
const MAX: Widths = { left: 360, right: 560 };
/** Lo que deben conservar juntas las dos columnas centrales: lista de commits
 * (220, su `minmax`) + diff (260, solo si no está colapsado). Con `minWidth`
 * 900 de la ventana, los laterales mínimos (140 + 220) y este suelo suman
 * exactamente 900 cuando el diff está visible. */
const CENTER_MIN_DIFF = 220 + 260;
const CENTER_MIN_COLLAPSED = 220;
const KEY_STEP = 16;

function clampOne(v: number, side: Side): number {
  return Math.min(MAX[side], Math.max(MIN[side], Math.round(v)));
}

/** Ancho efectivo de cada panel para una ventana de `total` px. `drag` es el
 * panel que se está arrastrando: si no caben los dos, cede ESE primero (se topa
 * contra el hueco que queda) y el otro no se mueve solo. `centerMin` es el
 * mínimo que deben dejar libre las dos columnas centrales — menor cuando la
 * columna de diff está colapsada (ver `CENTER_MIN_COLLAPSED`). */
export function clampPanels(
  w: Widths,
  total: number,
  drag: Side | null,
  centerMin: number = CENTER_MIN_DIFF,
): Widths {
  let left = clampOne(w.left, "left");
  let right = clampOne(w.right, "right");
  let overflow = left + right - (total - centerMin);
  if (overflow > 0) {
    // Sin arrastre (ventana que se achica, ancho guardado en otra pantalla)
    // cede primero el derecho, que tiene más recorrido. Siempre hasta su mínimo.
    const order: Side[] = drag === "left" ? ["left", "right"] : ["right", "left"];
    for (const side of order) {
      const cur = side === "left" ? left : right;
      const cut = Math.min(overflow, cur - MIN[side]);
      if (side === "left") left -= cut;
      else right -= cut;
      overflow -= cut;
      if (overflow <= 0) break;
    }
  }
  return { left, right };
}

function load(): Widths {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Widths>;
      if (typeof p.left === "number" && typeof p.right === "number")
        return { left: p.left, right: p.right };
    }
  } catch {
    // JSON roto o localStorage bloqueado: se usan los valores por defecto.
  }
  return DEFAULTS;
}

function save(w: Widths): void {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(w));
  } catch {
    // No es crítico.
  }
}

export function usePanels(diffCollapsed = false) {
  const [pref, setPref] = useState<Widths>(load);
  const [total, setTotal] = useState(() => window.innerWidth);
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ side: Side; pref: Widths } | null>(null);
  const centerMin = diffCollapsed ? CENTER_MIN_COLLAPSED : CENTER_MIN_DIFF;

  useEffect(() => {
    const onResize = () => setTotal(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const eff = clampPanels(pref, total, null, centerMin);

  /** Escribe las variables CSS directamente en el DOM. Durante el arrastre evita
   * re-renderizar `App` (1600 líneas) en cada `pointermove`. */
  const paint = (w: Widths) => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.setProperty("--w-left", `${w.left}px`);
    el.style.setProperty("--w-right", `${w.right}px`);
  };

  const widthFromPointer = (side: Side, clientX: number): number => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return DEFAULTS[side];
    return side === "left" ? clientX - rect.left : rect.right - clientX;
  };

  const onPointerDown = useCallback(
    (side: Side) => (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { side, pref };
      document.body.classList.add("resizing");
    },
    [pref],
  );

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = { ...d.pref, [d.side]: widthFromPointer(d.side, e.clientX) };
    d.pref = next;
    paint(clampPanels(next, window.innerWidth, d.side, centerMin));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove("resizing");
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    // Lo que se guarda es lo que se VE (ya clampado), no el puntero crudo:
    // arrastrar mucho más allá del máximo no debe dejar un "ancho fantasma".
    const shown = clampPanels(d.pref, window.innerWidth, d.side, centerMin);
    setPref(shown);
    save(shown);
  };

  const reset = (side: Side) => {
    const next = { ...pref, [side]: DEFAULTS[side] };
    setPref(next);
    save(next);
  };

  const onKeyDown = (side: Side) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    // ArrowRight agranda el panel izquierdo y encoge el derecho.
    const dir = (e.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
    const shown = clampPanels(
      { ...eff, [side]: eff[side] + dir * KEY_STEP },
      window.innerWidth,
      side,
      centerMin,
    );
    setPref(shown);
    save(shown);
  };

  const handleProps = (side: Side) => ({
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-label": side === "left" ? "Ancho del panel de ramas" : "Ancho del panel derecho",
    "aria-valuenow": eff[side],
    "aria-valuemin": MIN[side],
    "aria-valuemax": MAX[side],
    tabIndex: 0,
    className: `resizer resizer-${side}`,
    onPointerDown: onPointerDown(side),
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick: () => reset(side),
    onKeyDown: onKeyDown(side),
  });

  const style = {
    "--w-left": `${eff.left}px`,
    "--w-right": `${eff.right}px`,
  } as React.CSSProperties;

  return { bodyRef, style, handleProps };
}
