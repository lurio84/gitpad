// Pruebas de `friendlyGitError` (src/format.ts) contra stderr REAL de git
// 2.55, capturado en vivo (fixture bare+2 clones divergiendo, ver el hilo de
// v0.9.0): `pull --ff-only` en la rama activa, y los refspecs sin `+` de
// fetch/push por rama y de `push` normal, para el mismo caso de divergencia.
// Node ≥ 22.18 ejecuta el .ts directamente.
//   node scripts/test-friendly-error.mjs   (sale con código 1 si algo falla)
import { friendlyGitError } from "../src/gitErrors.ts";

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLO"} — ${label}${extra ? `  [${extra}]` : ""}`);
  if (!cond) fails++;
};

const PULL = "No se puede hacer Pull";
const PUSH = "Haz Pull primero";

// pull --ff-only (rama activa), git 2.55 real.
check(
  "pull --ff-only diverge: mensaje de Pull",
  friendlyGitError(
    `git falló (128): hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nhint:\nhint: Disable this message with "git config set advice.diverging false"\nfatal: Not possible to fast-forward, aborting.`,
  ).includes(PULL),
);

// fetch_branch (rama no activa) con refspec sin +: mismo mensaje de Pull,
// es un fetch que rechaza un non-fast-forward.
check(
  "fetch por rama no activa, non-fast-forward: mensaje de Pull",
  friendlyGitError(
    `git falló (1): From origin\n ! [rejected] master     -> master  (non-fast-forward)\n   428e465..9b974fc master     -> origin/master`,
  ).includes(PULL),
);

// push (rama activa) rechazado, sin refspec explícito.
check(
  "push activa rechazado (fetch first): mensaje de Push",
  friendlyGitError(
    `git falló (1): To origin\n ! [rejected]        master -> master (fetch first)\nerror: failed to push some refs to 'origin'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally.`,
  ).includes(PUSH),
);

// push_branch (rama no activa) con refspec sin +.
check(
  "push por rama no activa, non-fast-forward: mensaje de Push",
  friendlyGitError(
    `git falló (1): To origin\n ! [rejected]        master -> master (non-fast-forward)\nerror: failed to push some refs to 'origin'\nhint: Updates were rejected because a pushed branch tip is behind its remote\nhint: counterpart.`,
  ).includes(PUSH),
);

// Push y Pull no comparten redacción (uno no afirma lo que el otro dice).
check(
  "Push y Pull son mensajes distintos",
  friendlyGitError(`git falló (1): ! [rejected] master -> master (fetch first)\nerror: failed to push some refs to 'x'`) !==
    friendlyGitError(`git falló (128): hint: Diverging branches can't be fast-forwarded`),
);

// Cualquier otro error de git pasa TAL CUAL (sin lista blanca de patrones).
const otro = "git falló (128): fatal: pathspec 'no-existe.txt' did not match any files";
check("error no reconocido: pasa crudo", friendlyGitError(otro) === otro);

console.log(fails === 0 ? "\n--- fin: TODO OK ---" : `\n${fails} FALLO(S)`);
process.exit(fails === 0 ? 0 : 1);
