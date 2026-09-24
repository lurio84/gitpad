/** Traduce un puñado de errores de divergencia conocidos (capturados en vivo
 * contra git 2.55, ver el hilo de v0.9.0) a una frase que Bernardo pueda
 * accionar. `pull --ff-only` (rama activa), y el refspec sin `+` de
 * fetch/push por rama y de `push` normal, dan tres formas de stderr
 * distintas para el MISMO caso — hay commits a los dos lados que no se
 * pueden combinar en fast-forward. Cualquier otro error pasa crudo.
 * Módulo aparte (sin más imports) para que los scripts de test lo carguen
 * directo con `node`, sin arrastrar Graph.tsx a través de format.ts. */
export function friendlyGitError(raw: string): string {
  const esDivergencia =
    /Diverging branches can't be fast-forwarded/.test(raw) ||
    (/\[rejected\]/.test(raw) && /(fetch first|non-fast-forward)/.test(raw));
  if (!esDivergencia) return raw;
  return (
    "La rama ha divergido del remoto: hay commits a los dos lados que no " +
    "se pueden combinar solos. Baja los cambios (Fetch) y decide un merge " +
    "o un rebase antes de subir los tuyos."
  );
}
