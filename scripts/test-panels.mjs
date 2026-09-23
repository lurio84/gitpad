// Pruebas de `clampPanels` (src/usePanels.ts, función pura). Node ≥ 22.18
// ejecuta el .ts directamente (type stripping). No hay runner de JS en el
// proyecto a propósito:
//   node scripts/test-panels.mjs        (sale con código 1 si algo falla)
import { clampPanels, DEFAULTS } from "../src/usePanels.ts";

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLO"} — ${label}${extra ? `  [${extra}]` : ""}`);
  if (!cond) fails++;
};

const CENTER_MIN_DIFF = 220 + 260;
const CENTER_MIN_COLLAPSED = 220;

// Ventana justa al mínimo declarado (900): con el diff visible, los anchos
// por defecto (180+280=460) más el suelo del centro (480) exceden 900 en 40,
// así que alguno de los dos laterales debe ceder.
let r = clampPanels(DEFAULTS, 900, null);
check(
  "diff visible a 900px: los laterales caben en lo que sobra",
  r.left + r.right <= 900 - CENTER_MIN_DIFF,
  JSON.stringify(r),
);

// Con el diff colapsado, el suelo del centro es menor (solo la lista de
// commits): a la misma ventana de 900px ya no hace falta ceder nada, los
// anchos por defecto quedan intactos.
r = clampPanels(DEFAULTS, 900, null, CENTER_MIN_COLLAPSED);
check(
  "diff colapsado a 900px: los anchos por defecto no se tocan",
  r.left === DEFAULTS.left && r.right === DEFAULTS.right,
  JSON.stringify(r),
);

// Colapsado dejar exactamente 220 (el mínimo real) libres: no debe quedar
// overflow.
r = clampPanels(DEFAULTS, DEFAULTS.left + DEFAULTS.right + CENTER_MIN_COLLAPSED, null, CENTER_MIN_COLLAPSED);
check(
  "diff colapsado en el límite exacto: sin overflow",
  r.left === DEFAULTS.left && r.right === DEFAULTS.right,
  JSON.stringify(r),
);

// Sin `centerMin` explícito, el valor por defecto sigue siendo el de diff
// visible (no hay callers viejos que se rompan silenciosamente).
r = clampPanels(DEFAULTS, 900, null);
check(
  "centerMin por defecto == diff visible",
  JSON.stringify(r) === JSON.stringify(clampPanels(DEFAULTS, 900, null, CENTER_MIN_DIFF)),
  JSON.stringify(r),
);

console.log(fails === 0 ? "\nTodo OK." : `\n${fails} fallo(s).`);
process.exit(fails === 0 ? 0 : 1);
