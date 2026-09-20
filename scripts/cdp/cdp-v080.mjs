// Verificación E2E de v0.8.0 contra la app real (dev o binario de producción):
// merge explícito, ramas y tags, historial de un archivo, reset/revert, …
//
// Autocontenido: crea sus repos de prueba en el directorio temporal y los
// borra. Respalda y RESTAURA `localStorage` (vía `_ls.mjs`), así que también se
// puede pasar contra la app instalada sin llevarse la sesión. Sale con código 1
// si falla un check o hay un error de consola/excepción.
//
//   node cdp-v080.mjs            (puerto CDP 9222, o CDP_PORT=...)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepLocalStorage } from "./_ls.mjs";

const PORT = process.env.CDP_PORT ?? "9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixtures ----------
const base = mkdtempSync(join(tmpdir(), "gitpad-v080-"));
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8" }).trim();
function initRepo(name) {
  const dir = join(base, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  return dir;
}
const put = (dir, rel, content) => {
  const p = join(dir, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};

// Repo M (merge): `limpia` toca otro archivo; `choca` edita la misma línea que
// master. Ambas salen del commit raíz, así que master y ellas divergen.
const M = initRepo("repoM");
put(M, "f.txt", "base\n");
git(M, "add", "-A");
git(M, "commit", "-q", "-m", "base");
const raiz = git(M, "rev-parse", "HEAD");
git(M, "checkout", "-q", "-b", "limpia");
put(M, "g.txt", "g\n");
git(M, "add", "-A");
git(M, "commit", "-q", "-m", "commit de limpia");
git(M, "checkout", "-q", "-b", "choca", raiz);
put(M, "f.txt", "base\nchoca\n");
git(M, "commit", "-qam", "cambio en choca");
git(M, "checkout", "-q", "master");
put(M, "f.txt", "base\nmaster\n");
git(M, "commit", "-qam", "cambio en master");
const rootM = git(M, "rev-parse", "--show-toplevel");

// ---------- CDP ----------
const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
const target = list.find(
  (t) => t.type === "page" && /^https?:\/\/(localhost:1420|tauri\.localhost)/.test(t.url ?? ""),
);
if (!target) {
  console.error("No hay página de gitpad con el puerto CDP abierto (ver scripts/cdp/README.md).");
  process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
let nextId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? "excepción");
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
    consoleErrors.push(msg.params.entry.text);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function ev(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval");
  return r.result.value;
}
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
const restoreLS = await keepLocalStorage(ev, send);

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLO"} — ${label}${extra ? `  [${extra}]` : ""}`);
  if (!cond) fails++;
};
async function waitFor(expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const v = await ev(expr).catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timeout esperando: ${expr}`);
}
/** Espera a que `fn` (síncrona, sobre git/disco) sea verdadera. */
async function waitGit(fn, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await sleep(250);
  }
  return false;
}
async function reloadWith(tabs, active) {
  await ev(`(() => {
    localStorage.setItem('gitpad:tabs', ${JSON.stringify(JSON.stringify(tabs))});
    localStorage.setItem('gitpad:active', ${JSON.stringify(active)});
    return 1; })()`);
  await send("Page.reload", { ignoreCache: true });
  await sleep(800);
  await waitFor("document.querySelector('.commit') ? 1 : null");
  // Los diálogos nativos de confirmación bloquearían el script.
  await ev("(() => { window.confirm = () => true; return 1; })()");
}
/** Pone el valor de un <select> de React (setter nativo + evento `change`). */
const selectValue = (sel, value) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value; })()`);
/** Clic en el primer botón de `scope` cuyo texto (recortado) es exactamente `text`. */
const clickBtn = (scope, text) =>
  ev(`(() => {
    const b = Array.from(document.querySelectorAll(${JSON.stringify(scope + " button")}))
      .find((x) => x.textContent.trim() === ${JSON.stringify(text)});
    if (!b || b.disabled) return false;
    b.click(); return true; })()`);
const btnDisabled = (scope, text) =>
  ev(`(() => {
    const b = Array.from(document.querySelectorAll(${JSON.stringify(scope + " button")}))
      .find((x) => x.textContent.trim() === ${JSON.stringify(text)});
    return b ? b.disabled : null; })()`);
const nParents = (dir, rev = "HEAD") =>
  git(dir, "rev-list", "--parents", "-n", "1", rev).split(/\s+/).length - 1;

try {
  // ===== Tanda 1. Merge explícito =====
  console.log("\n# 1. Merge explícito");
  await reloadWith([rootM], rootM);
  await waitFor("document.querySelector('.rebase-box select') ? 1 : null");
  check("el rótulo de la caja es «Rebase / Merge»",
    (await ev("document.querySelector('.rebase-box .branch-group-label').textContent")) === "Rebase / Merge");
  check("«Merge aquí» deshabilitado sin rama elegida", (await btnDisabled(".rebase-box", "Merge aquí")) === true);

  // 1a. Merge limpio: master y `limpia` divergen sin tocar el mismo archivo.
  const antes = git(M, "rev-parse", "HEAD");
  check("el selector ofrece ramas locales", (await selectValue(".rebase-box select", "limpia")) === "limpia");
  check("«Merge aquí» se habilita al elegir rama", (await btnDisabled(".rebase-box", "Merge aquí")) === false);
  await clickBtn(".rebase-box", "Merge aquí");
  check("merge limpio: HEAD avanza", await waitGit(() => git(M, "rev-parse", "HEAD") !== antes));
  check("merge limpio: commit de fusión con dos padres", nParents(M) === 2);
  check("merge limpio: el archivo de la otra rama llega", existsSync(join(M, "g.txt")));
  check("merge limpio: sin banner de conflicto", (await ev("!!document.querySelector('.conflict-banner')")) === false);
  check("merge limpio: sin mensaje de error", (await ev("!!document.querySelector('.error, .banner.error')")) === false);
  check("merge limpio: el historial de la UI incluye el commit de limpia",
    await waitFor("Array.from(document.querySelectorAll('.commit')).some(e => e.textContent.includes('commit de limpia')) ? 1 : null").then(() => true, () => false));

  // 1b. Conflicto: banner, Abortar deja HEAD exacto.
  const cabeza = git(M, "rev-parse", "HEAD");
  await selectValue(".rebase-box select", "choca");
  await clickBtn(".rebase-box", "Merge aquí");
  check("conflicto: aparece el banner «Merge en curso»",
    await waitFor("document.querySelector('.conflict-banner')?.textContent.includes('Merge en curso') ? 1 : null").then(() => true, () => false));
  check("conflicto: git tiene MERGE_HEAD", existsSync(join(M, ".git", "MERGE_HEAD")));
  check("conflicto: «Merge aquí» y «Rebase aquí» quedan deshabilitados",
    (await btnDisabled(".rebase-box", "Merge aquí")) === true && (await btnDisabled(".rebase-box", "Rebase aquí")) === true);
  await clickBtn(".conflict-banner", "Abortar");
  check("abortar: desaparece el banner",
    await waitFor("document.querySelector('.conflict-banner') ? null : 1").then(() => true, () => false));
  check("abortar: HEAD queda exactamente donde estaba", git(M, "rev-parse", "HEAD") === cabeza);
  check("abortar: MERGE_HEAD ya no existe", !existsSync(join(M, ".git", "MERGE_HEAD")));

  // 1c. Conflicto de nuevo, resolver a mano y Continuar.
  await selectValue(".rebase-box select", "choca");
  await clickBtn(".rebase-box", "Merge aquí");
  await waitFor("document.querySelector('.conflict-banner') ? 1 : null");
  put(M, "f.txt", "base\nmaster\nchoca\n");
  git(M, "add", "-A");
  await clickBtn(".conflict-banner", "Continuar");
  check("continuar: termina el merge (dos padres)", await waitGit(() => !existsSync(join(M, ".git", "MERGE_HEAD")) && nParents(M) === 2));
  check("continuar: desaparece el banner",
    await waitFor("document.querySelector('.conflict-banner') ? null : 1").then(() => true, () => false));
  check("continuar: el contenido resuelto es el que se commiteó", git(M, "show", "HEAD:f.txt") === "base\nmaster\nchoca");
} finally {
  await restoreLS();
  ws.close();
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nerrores de consola: ${consoleErrors.length}`);
consoleErrors.forEach((e) => console.log("  -", e));
console.log(`--- fin: ${fails === 0 && consoleErrors.length === 0 ? "TODO OK" : `${fails} fallo(s), ${consoleErrors.length} error(es) de consola`} ---`);
process.exit(fails === 0 && consoleErrors.length === 0 ? 0 : 1);
