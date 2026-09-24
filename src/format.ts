import { WIP_HASH } from "./Graph";
import type { Branch, Commit, GitError, OpState } from "./types";

/** Ref completa que se le pasa a `get_log` para ver solo una rama. */
export const branchRef = (b: Branch) => (b.is_remote ? "refs/remotes/" : "refs/heads/") + b.name;
export const branchLabel = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

/** Clase de un botón con una operación en curso: el CSS dibuja un spinner encima
 * y deja la etiqueta (invisible) donde está, así el botón no cambia de ancho ni
 * desplaza a los de al lado. */
export const busyClass = (busy: boolean): string | undefined => (busy ? "busy" : undefined);

/** "19 sep" el mismo año, "19 sep 2025" otro año. El detalle completo va en el
 * `title`: en la columna de commits, que es estrecha, la fecha larga se partía. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

export function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

/** Commit sintético para el nodo //WIP (equivalente al de GitKraken): se
 * antepone a la lista real solo para dibujar el grafo y la fila de la
 * lista, nunca se manda a un comando git. */
export function wipCommit(parent: string): Commit {
  return {
    hash: WIP_HASH,
    short_hash: "",
    parents: [parent],
    author_name: "",
    author_email: "",
    date: "",
    subject: "//WIP",
    refs: [],
    body: "",
  };
}

export function isGitError(e: unknown): e is GitError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

/** Nombre en español de una operación en curso, para meterlo en la
 * confirmación de «Abortar» (antes era genérica, sin decir cuál). */
export function opLabel(kind: OpState["kind"]): string {
  switch (kind) {
    case "rebase":
      return "el rebase";
    case "cherry_pick":
      return "el cherry-pick";
    case "merge":
      return "el merge";
    case "revert":
      return "el revert";
  }
}

export { friendlyGitError } from "./gitErrors";
