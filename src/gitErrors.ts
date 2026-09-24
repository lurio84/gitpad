/** Traduce un puñado de errores de git conocidos (capturados en vivo contra
 * git 2.55, ver el hilo de v0.9.0) a una frase que Bernardo pueda accionar.
 * Dos mensajes, no uno — un push rechazado también pasa cuando la rama solo
 * va por detrás del remoto (sin divergencia real), así que el lado de push
 * no puede afirmar "commits a los dos lados" sin más:
 *
 * - Pull/fetch («Diverging branches can't be fast-forwarded», y el refspec
 *   sin `+` de fetch por rama con `[rejected] ... (non-fast-forward)»):
 *   divergencia real, `pull --ff-only`/`fetch_branch` (repo.rs) rechazan.
 * - Push (push() y push_branch(), las dos con «failed to push some refs»):
 *   puede ser divergencia o solo ir por detrás — el mensaje no distingue
 *   entre los dos porque git tampoco se lo dice a la app de forma fiable.
 *
 * Cualquier otro error pasa crudo. Módulo aparte (sin más imports) para que
 * los scripts de test lo carguen directo con `node`, sin arrastrar
 * Graph.tsx a través de format.ts. */
export function friendlyGitError(raw: string): string {
  if (/\[rejected\]/.test(raw) && /failed to push/.test(raw)) {
    return (
      "El remoto tiene commits que tu rama no tiene. Haz Pull primero; " +
      "si tu rama también tiene commits propios, combínalos con un merge " +
      "o un rebase y vuelve a hacer Push."
    );
  }
  const esDivergenciaAlTraer =
    /Diverging branches can't be fast-forwarded/.test(raw) ||
    (/\[rejected\]/.test(raw) && /non-fast-forward/.test(raw));
  if (esDivergenciaAlTraer) {
    return (
      "No se puede hacer Pull: la rama y el remoto han divergido (hay " +
      "commits nuevos en los dos lados). Combínalos con un merge o un " +
      "rebase sobre la rama del remoto."
    );
  }
  return raw;
}
