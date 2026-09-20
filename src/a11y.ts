// Teclado para filas y pestañas que son `li`/`div` con `onClick` (no `button`).
// El patrón es siempre el mismo: la tecla dispara el clic del propio elemento,
// así que ningún handler existente se duplica ni se refactoriza.

import type { KeyboardEvent } from "react";

/** Enter o Espacio sobre el elemento enfocado = un clic sobre él. Solo si la
 * tecla nace en el propio elemento: en un botón anidado (cherry-pick, cerrar
 * pestaña, stage…) ese botón ya se activa solo y aquí se dispararía dos veces. */
function activateOnKey(e: KeyboardEvent<HTMLElement>): boolean {
  if (e.target !== e.currentTarget) return false;
  if (e.key !== "Enter" && e.key !== " ") return false;
  e.preventDefault(); // Espacio no debe desplazar el panel
  e.currentTarget.click();
  return true;
}

/** Elemento enfocable con Tab y activable con Enter/Espacio. */
export const focusable = {
  tabIndex: 0,
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void activateOnKey(e),
};

/**
 * Fila de una lista larga (los commits): una sola parada de Tab en toda la
 * lista (`tabStop`: la fila seleccionada, o la primera) y flechas ↑/↓,
 * Inicio/Fin para moverse entre hermanos. Sin esto, 200 commits son 200 Tab.
 */
export function listRow(tabStop: boolean) {
  return {
    tabIndex: tabStop ? 0 : -1,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (activateOnKey(e)) return;
      if (e.target !== e.currentTarget) return;
      const cur = e.currentTarget;
      const to =
        e.key === "ArrowDown"
          ? cur.nextElementSibling
          : e.key === "ArrowUp"
            ? cur.previousElementSibling
            : e.key === "Home"
              ? cur.parentElement?.firstElementChild
              : e.key === "End"
                ? cur.parentElement?.lastElementChild
                : null;
      if (to instanceof HTMLElement) {
        e.preventDefault();
        to.focus();
        to.scrollIntoView({ block: "nearest" });
      }
    },
  };
}
