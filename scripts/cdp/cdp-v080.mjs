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

// Repo N (ramas y tags): rama y tag HOMÓNIMOS `v1` en el mismo commit (el
// caso que antes hacía desaparecer el tag), una rama con `/`, y `propia` con
// un commit que no está en master (para el borrado no fusionado).
const N = initRepo("repoN");
put(N, "a.txt", "1\n");
git(N, "add", "-A");
git(N, "commit", "-q", "-m", "primer commit");
const c1 = git(N, "rev-parse", "HEAD");
put(N, "a.txt", "2\n");
git(N, "commit", "-qam", "segundo commit");
git(N, "branch", "v1");
git(N, "tag", "v1");
git(N, "branch", "feature/x");
git(N, "checkout", "-q", "-b", "propia");
put(N, "p.txt", "p\n");
git(N, "add", "-A");
git(N, "commit", "-q", "-m", "solo en propia");
git(N, "checkout", "-q", "master");
const rootN = git(N, "rev-parse", "--show-toplevel");
const branchesN = () => git(N, "branch", "--format=%(refname:short)").split("\n").sort().join(",");

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

  // ===== Tanda 2. Ramas y tags =====
  console.log("\n# 2. Ramas y tags");
  await reloadWith([rootN], rootN);
  await waitFor("document.querySelector('.ref') ? 1 : null");

  // 2a. Rama y tag homónimos: los dos chips salen, con su tipo.
  const chipsTop = await ev(`(() => {
    const row = Array.from(document.querySelectorAll('.commit')).find((e) => e.textContent.includes('segundo commit'));
    return Array.from(row.querySelectorAll('.ref')).map((r) => r.className.replace('ref ', '') + ':' + r.textContent);
  })()`);
  check("homónimos: sale el chip del TAG v1", chipsTop.includes("tag:v1"), chipsTop.join(" "));
  check("homónimos: sale el chip de la RAMA v1", chipsTop.includes("local:v1"), chipsTop.join(" "));
  check("rama con barra: feature/x es local, no remota", chipsTop.includes("local:feature/x"), chipsTop.join(" "));
  check("la rama activa lleva chip head", chipsTop.includes("head:master"), chipsTop.join(" "));

  // Diálogos: `prompt` devuelve lo que se le indique; `confirm` consume respuestas.
  const answer = (prompt, confirms = []) =>
    ev(`(() => {
      window.__pa = ${JSON.stringify(prompt)};
      window.__ca = ${JSON.stringify(confirms)};
      window.__msgs = [];
      window.prompt = (m) => { window.__msgs.push(m); return window.__pa; };
      window.confirm = (m) => { window.__msgs.push(m); return window.__ca.length ? window.__ca.shift() : true; };
      return 1; })()`);
  const msgs = () => ev("window.__msgs");
  const rightClick = (expr) =>
    ev(`(() => {
      const el = (${expr});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 }));
      return true; })()`);
  const branchRow = (n) =>
    `Array.from(document.querySelectorAll('.branch-item')).find((e) => e.querySelector('.branch-name').textContent === ${JSON.stringify(n)})`;
  const commitRow = (t) =>
    `Array.from(document.querySelectorAll('.commit')).find((e) => e.textContent.includes(${JSON.stringify(t)}))`;
  const menuItems = () => ev("Array.from(document.querySelectorAll('.ctx-menu button')).map((b) => b.textContent.trim() + (b.disabled ? ' [off]' : ''))");
  const menuHeading = () => ev("document.querySelector('.ctx-menu .ctx-heading')?.textContent ?? null");

  // 2b. Crear rama con el «＋» (en HEAD) → cambia a ella.
  await answer("nueva-ui");
  check("«＋ Nueva rama» está visible junto a «Ramas»", await ev("!!document.querySelector('.branches-head button')"));
  await ev("document.querySelector('.branches-head button').click()");
  check("crear rama con ＋: git cambia a la rama nueva", await waitGit(() => git(N, "branch", "--show-current") === "nueva-ui"));
  check("crear rama con ＋: nace en HEAD", git(N, "rev-parse", "nueva-ui") === git(N, "rev-parse", "master"));
  check("crear rama con ＋: la UI la marca como actual",
    await waitFor(`(${branchRow("nueva-ui")})?.classList.contains('current') ? 1 : null`).then(() => true, () => false));

  // 2c. Clic derecho en un commit → menú → crear rama en ese commit.
  await ev("document.body.click()");
  check("clic derecho en un commit abre el menú", await rightClick(commitRow("primer commit")));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  check("el menú del commit ofrece crear rama y tag", JSON.stringify(await menuItems()) === JSON.stringify(["Crear rama aquí…", "Crear tag aquí…"]), (await menuItems()).join("|"));
  check("el encabezado del menú dice sobre qué actúa", (await menuHeading())?.includes("primer commit"), await menuHeading());
  check("el foco entra en la primera opción del menú", await ev("document.activeElement?.closest('.ctx-menu') !== null"));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  check("Escape cierra el menú", await waitFor("document.querySelector('.ctx-menu') ? null : 1").then(() => true, () => false));
  await rightClick(commitRow("primer commit"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await answer("desde-c1");
  await clickBtn(".ctx-menu", "Crear rama aquí…");
  check("crear rama en un commit: HEAD queda en ese commit", await waitGit(() => git(N, "rev-parse", "HEAD") === c1 && git(N, "branch", "--show-current") === "desde-c1"));
  check("el menú se cierra al elegir una opción", (await ev("!!document.querySelector('.ctx-menu')")) === false);

  // 2d. Tag en un commit concreto, y borrarlo con clic derecho sobre su chip.
  await rightClick(commitRow("segundo commit"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await answer("tag-ui");
  await clickBtn(".ctx-menu", "Crear tag aquí…");
  const c2 = git(N, "rev-parse", "master");
  check("crear tag en un commit: apunta a ese commit", await waitGit(() => { try { return git(N, "rev-parse", "tag-ui^{commit}") === c2; } catch { return false; } }));
  await waitFor("document.querySelector('.ref.tag') ? 1 : null");
  check("el tag nuevo sale como chip de tag",
    await waitFor("Array.from(document.querySelectorAll('.ref.tag')).some((r) => r.textContent === 'tag-ui') ? 1 : null").then(() => true, () => false));
  await answer("", [true]);
  await rightClick("Array.from(document.querySelectorAll('.ref.tag')).find((r) => r.textContent === 'tag-ui')");
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  check("el menú de un tag ofrece borrarlo (en rojo)", (await ev("document.querySelector('.ctx-menu button.danger')?.textContent.trim()")) === "Borrar tag…");
  await clickBtn(".ctx-menu", "Borrar tag…");
  check("borrar tag: git ya no lo tiene", await waitGit(() => git(N, "tag", "--list", "tag-ui") === ""));

  // 2e. Renombrar una rama desde su menú.
  await rightClick(branchRow("feature/x"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  check("el menú de una rama local: Checkout, Merge, Renombrar, Borrar",
    JSON.stringify(await menuItems()) === JSON.stringify(["Checkout", "Merge en la rama actual", "Renombrar…", "Borrar…"]), (await menuItems()).join("|"));
  await answer("feature/renombrada");
  await clickBtn(".ctx-menu", "Renombrar…");
  check("renombrar: git tiene el nombre nuevo y ya no el viejo",
    await waitGit(() => branchesN().includes("feature/renombrada") && !branchesN().includes("feature/x,")));

  // 2f. Borrar la rama activa está deshabilitado; una fusionada se borra directo.
  await rightClick(branchRow("desde-c1"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  check("la rama activa no se puede borrar desde el menú", (await menuItems()).includes("Borrar… [off]"), (await menuItems()).join("|"));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor("document.querySelector('.ctx-menu') ? null : 1");
  git(N, "checkout", "-q", "master");
  await ev("document.querySelector('.rebase-box') && 1");
  await send("Page.reload", { ignoreCache: true });
  await sleep(800);
  await waitFor("document.querySelector('.commit') ? 1 : null");
  await answer("", [true]);
  await rightClick(branchRow("desde-c1"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await clickBtn(".ctx-menu", "Borrar…");
  check("borrar una rama fusionada: se borra con una sola confirmación",
    await waitGit(() => !branchesN().includes("desde-c1")) && (await msgs()).length === 1, (await msgs()).join(" / "));

  // 2g. No fusionada: pide confirmación extra. Si se rechaza, NO se borra.
  await answer("", [true, false]);
  await rightClick(branchRow("propia"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await clickBtn(".ctx-menu", "Borrar…");
  await sleep(1200);
  check("no fusionada: pregunta dos veces (borrar, y forzar)", (await msgs()).length === 2, (await msgs()).join(" / "));
  check("no fusionada + rechazar el forzado: la rama sigue", branchesN().includes("propia"));
  check("no fusionada + rechazar: se explica por qué en pantalla",
    (await ev("document.querySelector('.error')?.textContent ?? ''")).includes("propia"), await ev("document.querySelector('.error')?.textContent ?? ''"));
  await answer("", [true, true]);
  await rightClick(branchRow("propia"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await clickBtn(".ctx-menu", "Borrar…");
  check("no fusionada + aceptar el forzado: se borra", await waitGit(() => !branchesN().includes("propia")));

  // 2h. Nombres inválidos: error visible y nada cambia.
  const antes2 = branchesN();
  await answer("a b");
  await ev("document.querySelector('.branches-head button').click()");
  check("nombre inválido: aparece el error", await waitFor("document.querySelector('.error') ? 1 : null").then(() => true, () => false));
  check("nombre inválido: no se crea nada", branchesN() === antes2);
} finally {
  await restoreLS();
  ws.close();
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nerrores de consola: ${consoleErrors.length}`);
consoleErrors.forEach((e) => console.log("  -", e));
console.log(`--- fin: ${fails === 0 && consoleErrors.length === 0 ? "TODO OK" : `${fails} fallo(s), ${consoleErrors.length} error(es) de consola`} ---`);
process.exit(fails === 0 && consoleErrors.length === 0 ? 0 : 1);
