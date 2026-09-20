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

// Repo P (historial, revert, reset): a.txt se renombra a b.txt (para probar que el
// historial de un archivo atraviesa el renombrado) y hay un commit de fusión.
const P = initRepo("repoP");
const cuerpo = "uno\ndos\ntres\ncuatro\ncinco\nseis\nsiete\nocho\n";
const commitP = (file, content, msg) => {
  put(P, file, content);
  git(P, "add", "-A");
  git(P, "commit", "-q", "-m", msg);
  return git(P, "rev-parse", "HEAD");
};
commitP("a.txt", cuerpo, "c1 crea a");
const p2 = commitP("o.txt", "otro\n", "c2 otro");
git(P, "mv", "a.txt", "b.txt");
git(P, "commit", "-q", "-m", "c3 renombra a a b");
commitP("b.txt", cuerpo + "x\n", "c4 toca b");
git(P, "checkout", "-q", "-b", "rm");
commitP("r.txt", "r\n", "c5 en rama");
git(P, "checkout", "-q", "master");
const p6 = commitP("m.txt", "m\n", "c6 en master");
git(P, "merge", "-q", "--no-edit", "rm");
commitP("b.txt", cuerpo + "x\ny\n", "c7 toca b otra vez");
const rootP = git(P, "rev-parse", "--show-toplevel");
const tipP = git(P, "rev-parse", "HEAD");
const subjectsP = () => git(P, "log", "--format=%s").split("\n");

// Repo Q (word-diff): un cambio de valor, una línea reescrita del todo y una de prosa.
const Q = initRepo("repoQ");
put(Q, "code.ts", "const total = 1;\nfoo(alpha, beta, gamma);\nEl gato negro duerme en el sofá viejo.\nsin cambios\n");
git(Q, "add", "-A");
git(Q, "commit", "-q", "-m", "q1 base");
put(Q, "code.ts", "const total = 2;\n1 2 3 4 5 6 7 8 9 10 11 12;\nEl gato blanco duerme en el sofá nuevo.\nsin cambios\n");
git(Q, "commit", "-qam", "q2 cambia valores");
const rootQ = git(Q, "rev-parse", "--show-toplevel");

// Repo R (teclado): una segunda rama a la que cambiar con Enter.
const R = initRepo("repoR");
put(R, "r.txt", "r\n");
git(R, "add", "-A");
git(R, "commit", "-q", "-m", "r1");
git(R, "branch", "otra");
const rootR = git(R, "rev-parse", "--show-toplevel");

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
  const menuHas = await menuItems();
  check("el menú del commit ofrece crear rama y tag (y, desde la Tanda 3, revert y reset)",
    ["Crear rama aquí…", "Crear tag aquí…"].every((x) => menuHas.includes(x)), menuHas.join("|"));
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

  // ===== Tanda 3. Historial de un archivo, revert y reset =====
  console.log("\n# 3. Historial de un archivo, revert y reset");
  await reloadWith([rootP], rootP);
  await ev("(() => { window.confirm = () => true; return 1; })()");
  const filas = () => ev("Array.from(document.querySelectorAll('.commit .subject')).map((e) => e.textContent)");
  const total = (await filas()).length;
  const selectCommit = async (t) => {
    await ev(`(${commitRow(t)}).click()`);
    await waitFor("document.querySelector('.entry') ? 1 : null");
  };

  // 3a. Historial de b.txt desde el listado de archivos de un commit.
  await selectCommit("c4 toca b");
  check("clic derecho en un archivo del commit abre el menú", await rightClick("Array.from(document.querySelectorAll('.entry')).find((e) => e.textContent.includes('b.txt'))"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  check("el menú del archivo ofrece «Ver historial de este archivo»",
    JSON.stringify(await menuItems()) === JSON.stringify(["Ver historial de este archivo"]), (await menuItems()).join("|"));
  await clickBtn(".ctx-menu", "Ver historial de este archivo");
  await waitFor("document.querySelector('.filter-info')?.textContent.includes('Historial de') ? 1 : null");
  // El banner sale al instante; la lista filtrada, al terminar la recarga: se espera a ella.
  await waitFor("document.querySelector('.filter-info')?.textContent.includes('cargando') ? null : 1");
  await waitFor(`document.querySelectorAll('.commit').length === ${total} ? null : 1`).catch(() => {});
  const soloB = await filas();
  check("el historial de b.txt: solo los commits que lo tocan, atravesando el renombrado",
    JSON.stringify(soloB) === JSON.stringify(["c7 toca b otra vez", "c4 toca b", "c3 renombra a a b", "c1 crea a"]), soloB.join(" | "));
  check("el banner nombra el archivo y cuenta los commits",
    (await ev("document.querySelector('.filter-info').textContent")).includes("b.txt") && (await ev("document.querySelector('.filter-info').textContent")).includes("4 commits"),
    await ev("document.querySelector('.filter-info').textContent"));
  check("sin nodo //WIP en el historial de un archivo", (await ev("!!document.querySelector('.commit.wip')")) === false);
  check("el grafo no dibuja líneas (no finge topología)", (await ev("document.querySelectorAll('svg.graph line, svg.graph path').length")) === 0);
  check("el grafo sí dibuja un punto por commit", (await ev("document.querySelectorAll('svg.graph circle').length")) === 4);
  await ev("Array.from(document.querySelectorAll('.filter-info button')).find((b) => /ver todo/.test(b.textContent)).click()");
  await waitFor("document.querySelector('.filter-info')?.textContent.includes('Historial de') ? null : 1");
  // Igual que al entrar: el banner se va al instante, la lista completa vuelve al terminar la recarga.
  await waitFor(`document.querySelectorAll('.commit').length === ${total} ? 1 : null`).catch(() => {});
  check("«ver todo» vuelve al historial completo", (await filas()).length === total, `${(await filas()).length} vs ${total}`);
  check("«ver todo» vuelve a dibujar las líneas del grafo", (await ev("document.querySelectorAll('svg.graph line, svg.graph path').length")) > 0);

  // 3b. Revert con conflicto: c4 (añade «x») choca con c7 (añade «y» justo debajo).
  const antesRevert = git(P, "rev-parse", "HEAD");
  await rightClick(commitRow("c4 toca b"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  const itemsC = await menuItems();
  check("el menú de un commit incluye Revert y los tres Reset",
    ["Revert de este commit…", "Reset soft a este commit…", "Reset mixed a este commit…", "Reset hard a este commit…"].every((x) => itemsC.includes(x)), itemsC.join("|"));
  check("Reset hard va en rojo", (await ev("document.querySelector('.ctx-menu button.danger')?.textContent.trim()")) === "Reset hard a este commit…");
  await answer("", [true]);
  await clickBtn(".ctx-menu", "Revert de este commit…");
  check("revert con conflicto: aparece el banner «Revert en curso»",
    await waitFor("document.querySelector('.conflict-banner')?.textContent.includes('Revert en curso') ? 1 : null").then(() => true, () => false));
  check("revert con conflicto: git tiene REVERT_HEAD", existsSync(join(P, ".git", "REVERT_HEAD")));
  await clickBtn(".conflict-banner", "Abortar");
  check("abortar el revert: desaparece el banner y HEAD queda exacto",
    await waitFor("document.querySelector('.conflict-banner') ? null : 1").then(() => true, () => false) && git(P, "rev-parse", "HEAD") === antesRevert);
  await rightClick(commitRow("c4 toca b"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await clickBtn(".ctx-menu", "Revert de este commit…");
  await waitFor("document.querySelector('.conflict-banner') ? 1 : null");
  put(P, "b.txt", cuerpo + "resuelto\n");
  git(P, "add", "-A");
  await clickBtn(".conflict-banner", "Continuar");
  check("continuar el revert: se crea el commit «Revert»", await waitGit(() => !existsSync(join(P, ".git", "REVERT_HEAD")) && subjectsP()[0].startsWith("Revert")));

  // 3c. Revert limpio (c6 solo añade m.txt) y merge no revertible.
  await reloadWith([rootP], rootP);
  await rightClick(commitRow("c6 en master"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await answer("", [true]);
  const nAntes = Number(git(P, "rev-list", "--count", "HEAD"));
  await clickBtn(".ctx-menu", "Revert de este commit…");
  check("revert limpio: commit nuevo (historia +1) y m.txt desaparece",
    await waitGit(() => Number(git(P, "rev-list", "--count", "HEAD")) === nAntes + 1 && !existsSync(join(P, "m.txt"))));
  await reloadWith([rootP], rootP);
  await rightClick(commitRow("Merge branch 'rm'"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  check("un commit de fusión no se puede revertir (deshabilitado)", (await menuItems()).includes("Revert de este commit… [off]"), (await menuItems()).join("|"));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

  // 3d. Reset. Se parte siempre de la punta original para que cada modo sea comparable.
  const irATip = () => { git(P, "reset", "-q", "--hard", tipP); git(P, "clean", "-fdq"); };
  irATip();
  await reloadWith([rootP], rootP);

  // Rechazar la confirmación no mueve nada.
  await answer("", [false]);
  await rightClick(commitRow("c2 otro"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await clickBtn(".ctx-menu", "Reset hard a este commit…");
  await sleep(700);
  check("reset: si se rechaza la confirmación no se mueve nada", git(P, "rev-parse", "HEAD") === tipP);

  // hard con un cambio sin guardar y un archivo sin seguir: la confirmación NOMBRA lo que se pierde.
  put(P, "b.txt", "cambio sucio\n");
  put(P, "sin_seguir.txt", "u\n");
  await reloadWith([rootP], rootP);
  await answer("", [true]);
  await rightClick(commitRow("c2 otro"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await clickBtn(".ctx-menu", "Reset hard a este commit…");
  check("reset hard: HEAD queda en el commit elegido", await waitGit(() => git(P, "rev-parse", "HEAD") === p2));
  const msgHard = (await msgs())[0] ?? "";
  check("reset hard: la confirmación nombra el archivo que se pierde", msgHard.includes("b.txt") && msgHard.includes("SE PERDERÁN"), msgHard.replace(/\n/g, " ⏎ "));
  check("reset hard: NO menciona el archivo sin seguir como perdido", !msgHard.includes("  • sin_seguir.txt"), msgHard.replace(/\n/g, " ⏎ "));
  check("reset hard: el archivo sin seguir sobrevive", existsSync(join(P, "sin_seguir.txt")));
  check("reset hard: descarta el cambio sin guardar (b.txt ya no existe en c2)", !existsSync(join(P, "b.txt")));

  // soft: la rama se mueve y los cambios quedan preparados.
  irATip();
  await reloadWith([rootP], rootP);
  await answer("", [true]);
  await rightClick(commitRow("c2 otro"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await clickBtn(".ctx-menu", "Reset soft a este commit…");
  check("reset soft: HEAD se mueve", await waitGit(() => git(P, "rev-parse", "HEAD") === p2));
  check("reset soft: los cambios quedan preparados (staged)", git(P, "diff", "--cached", "--name-only").length > 0);
  check("reset soft: la confirmación NO habla de perder cambios", !((await msgs())[0] ?? "").includes("SE PERDERÁN"));

  // mixed: la rama se mueve y los cambios quedan en la carpeta sin preparar.
  irATip();
  await reloadWith([rootP], rootP);
  await answer("", [true]);
  await rightClick(commitRow("c2 otro"));
  await waitFor("document.querySelector('.ctx-menu') ? 1 : null");
  await clickBtn(".ctx-menu", "Reset mixed a este commit…");
  check("reset mixed: HEAD se mueve", await waitGit(() => git(P, "rev-parse", "HEAD") === p2));
  check("reset mixed: nada preparado y el contenido sigue en la carpeta",
    git(P, "diff", "--cached", "--name-only") === "" && existsSync(join(P, "b.txt")));

  // ===== Tanda 4. Word-diff intra-línea =====
  console.log("\n# 4. Word-diff intra-línea");
  await reloadWith([rootQ], rootQ);
  await ev(`(${commitRow("q2 cambia valores")}).click()`);
  await waitFor("document.querySelector('.entry') ? 1 : null");
  await ev("Array.from(document.querySelectorAll('.entry')).find((e) => e.textContent.includes('code.ts')).click()");
  await waitFor("document.querySelector('.diff-wrap') ? 1 : null");
  const wd = (sel) => ev(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map((e) => e.textContent)`);
  const modo = async (texto) => {
    await ev(`Array.from(document.querySelectorAll('.diff-toolbar button')).find((b) => b.textContent.trim() === ${JSON.stringify(texto)}).click()`);
    await sleep(300);
  };

  await modo("Side by side");
  check("lado a lado: la palabra que cambia se marca en el lado nuevo (2, blanco, nuevo)",
    JSON.stringify(await wd(".split-text.add .wd")) === JSON.stringify(["2", "blanco", "nuevo"]), JSON.stringify(await wd(".split-text.add .wd")));
  check("lado a lado: y en el viejo (1, negro, viejo)",
    JSON.stringify(await wd(".split-text.del .wd")) === JSON.stringify(["1", "negro", "viejo"]), JSON.stringify(await wd(".split-text.del .wd")));
  const filaNueva = await wd(".split-text.add");
  check("lado a lado: la línea reescrita del todo NO se resalta (sería ruido)",
    filaNueva.includes("1 2 3 4 5 6 7 8 9 10 11 12;") &&
      (await ev("Array.from(document.querySelectorAll('.split-text.add')).find((e) => e.textContent.startsWith('1 2 3'))?.querySelector('.wd') === null")));
  check("lado a lado: el texto visible queda intacto con los resaltados dentro",
    filaNueva.includes("const total = 2;") && filaNueva.includes("El gato blanco duerme en el sofá nuevo."), filaNueva.join(" ⏎ "));
  check("lado a lado: la línea sin cambios no lleva resaltado", (await ev("document.querySelectorAll('.split-text.ctx .wd').length")) === 0);

  await modo("Unified");
  check("unificada: mismas palabras marcadas en las líneas añadidas",
    JSON.stringify(await wd(".dl.add .wd")) === JSON.stringify(["2", "blanco", "nuevo"]), JSON.stringify(await wd(".dl.add .wd")));
  check("unificada: y en las borradas", JSON.stringify(await wd(".dl.del .wd")) === JSON.stringify(["1", "negro", "viejo"]), JSON.stringify(await wd(".dl.del .wd")));
  const lineasAdd = await wd(".dl.add");
  check("unificada: conserva el «+» y el texto exacto de la línea", lineasAdd.includes("+const total = 2;") && lineasAdd.includes("+El gato blanco duerme en el sofá nuevo."), lineasAdd.join(" ⏎ "));
  check("el resaltado tiene fondo propio (no es solo un span)",
    (await ev("getComputedStyle(document.querySelector('.dl.add .wd')).backgroundColor")) !== "rgba(0, 0, 0, 0)");
  await modo("Side by side");

  // ===== Tanda 4. Teclado y ARIA (eventos de teclado REALES de CDP) =====
  console.log("\n# 5. Teclado y ARIA");
  const press = async (key, code, vk, text) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
    await sleep(150);
  };
  const enter = () => press("Enter", "Enter", 13, "\r");
  const down = () => press("ArrowDown", "ArrowDown", 40);
  const up = () => press("ArrowUp", "ArrowUp", 38);
  const home = () => press("Home", "Home", 36);
  const end = () => press("End", "End", 35);
  const focusIdx = (i) => ev(`(() => { const r = document.querySelectorAll('.commit')[${i}]; r.focus(); return document.activeElement === r; })()`);
  const activeIdx = () => ev("Array.from(document.querySelectorAll('.commit')).indexOf(document.activeElement)");

  // Commits: una sola parada de Tab, flechas, Inicio/Fin, Enter.
  await reloadWith([rootP], rootP);
  const nRows = await ev("document.querySelectorAll('.commit').length");
  check("commits: UNA sola parada de Tab en toda la lista (roving tabindex)",
    (await ev("document.querySelectorAll('.commit[tabindex=\"0\"]').length")) === 1, `${nRows} filas`);
  check("commits: las demás filas se enfocan por código pero no por Tab",
    (await ev("document.querySelectorAll('.commit[tabindex=\"-1\"]').length")) === nRows - 1);
  await focusIdx(0);
  await down();
  check("commits: ↓ mueve el foco a la fila siguiente", (await activeIdx()) === 1, String(await activeIdx()));
  await down();
  await up();
  check("commits: ↑ vuelve a la anterior", (await activeIdx()) === 1, String(await activeIdx()));
  await end();
  check("commits: Fin va a la última fila", (await activeIdx()) === nRows - 1, String(await activeIdx()));
  await home();
  check("commits: Inicio va a la primera", (await activeIdx()) === 0, String(await activeIdx()));
  await down();
  await enter();
  check("commits: Enter selecciona la fila enfocada", await waitFor("document.querySelectorAll('.commit.sel').length === 1 ? 1 : null").then(() => true, () => false));
  check("commits: la fila seleccionada lleva aria-current", (await ev("document.querySelector('.commit.sel')?.getAttribute('aria-current')")) === "true");
  check("commits: la parada de Tab pasa a la fila seleccionada",
    (await ev("document.querySelector('.commit.sel')?.getAttribute('tabindex')")) === "0" && (await ev("document.querySelectorAll('.commit[tabindex=\"0\"]').length")) === 1);

  // Un archivo del commit: Enter carga su diff.
  await waitFor("document.querySelector('.entry') ? 1 : null");
  check("archivos: la fila entra en el orden de Tab", (await ev("document.querySelector('.entry')?.getAttribute('tabindex')")) === "0");
  await ev("document.querySelector('.entry').focus()");
  await enter();
  check("archivos: Enter abre el diff del archivo", await waitFor("document.querySelector('.diff-wrap') ? 1 : null").then(() => true, () => false));

  // Pestañas: roles ARIA, Enter para cambiar y Enter en «×» sin doble disparo.
  await reloadWith([rootP, rootN], rootP);
  await waitFor("document.querySelectorAll('.tab').length === 2 ? 1 : null");
  check("pestañas: el contenedor es un tablist y cada pestaña un tab",
    (await ev("document.querySelector('nav.tabs')?.getAttribute('role')")) === "tablist" && (await ev("Array.from(document.querySelectorAll('.tab')).every((t) => t.getAttribute('role') === 'tab')")));
  check("pestañas: aria-selected refleja la activa", (await ev("Array.from(document.querySelectorAll('.tab')).map((t) => t.getAttribute('aria-selected')).join()")) === "true,false");
  await ev("document.querySelectorAll('.tab')[1].focus()");
  await enter();
  check("pestañas: Enter en una pestaña la activa",
    await waitFor("document.querySelectorAll('.tab')[1].classList.contains('active') ? 1 : null").then(() => true, () => false));
  check("pestañas: aria-selected sigue a la activa", (await ev("Array.from(document.querySelectorAll('.tab')).map((t) => t.getAttribute('aria-selected')).join()")) === "false,true");
  // Enter sobre el «×»: cierra ESA pestaña y no dispara además el clic de la pestaña.
  await ev("document.querySelectorAll('.tab')[0].querySelector('.tab-close').focus()");
  await enter();
  check("pestañas: Enter en «×» la cierra (una sola pestaña queda)",
    await waitFor("document.querySelectorAll('.tab').length === 1 ? 1 : null").then(() => true, () => false));
  check("pestañas: y la que queda es la otra (no hubo doble disparo)", (await ev("document.querySelector('.tab .tab-name').textContent")) === "repoN", await ev("document.querySelector('.tab .tab-name').textContent"));

  // Ramas: Enter en una rama no actual hace checkout.
  await reloadWith([rootR], rootR);
  check("ramas: la rama actual lleva aria-current", (await ev("document.querySelector('.branch-item.current')?.getAttribute('aria-current')")) === "true");
  await ev(`(${branchRow("otra")}).focus()`);
  await enter();
  check("ramas: Enter sobre «otra» hace checkout", await waitGit(() => git(R, "branch", "--show-current") === "otra"));

  // ===== Tanda 4. Estados vacíos =====
  console.log("\n# 6. Estados vacíos");
  await reloadWith([rootR], rootR);
  check("con commits no sale el mensaje de lista vacía", (await ev("!!document.querySelector('.empty-log')")) === false);
  // Búsqueda sin resultados: mensaje explícito (antes, una columna en blanco).
  await ev(`(() => {
    const el = document.querySelector('input[placeholder="Buscar commits…"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'zzz-no-existe-zzz');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1; })()`);
  await ev("Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Buscar').click()");
  check("búsqueda sin resultados: «Ningún commit coincide con el filtro.»",
    await waitFor("document.querySelector('.empty-log')?.textContent.includes('Ningún commit coincide') ? 1 : null").then(() => true, () => false),
    await ev("document.querySelector('.empty-log')?.textContent ?? '(sin mensaje)'"));
  check("búsqueda sin resultados: sigue el banner con el recuento", (await ev("document.querySelector('.filter-info')?.textContent.includes('0 resultados') ?? false")) === true);
  // Sección sin nada: texto y no un guion suelto.
  put(R, "nuevo.txt", "n\n");
  await reloadWith([rootR], rootR);
  const filasVacias = await ev("Array.from(document.querySelectorAll('.clean-row')).map((e) => e.textContent)");
  check("secciones vacías: «Nada preparado» en vez de un «—»", filasVacias.includes("Nada preparado") && !filasVacias.includes("—"), filasVacias.join("|"));
  rmSync(join(R, "nuevo.txt"));
} finally {
  await restoreLS();
  ws.close();
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nerrores de consola: ${consoleErrors.length}`);
consoleErrors.forEach((e) => console.log("  -", e));
console.log(`--- fin: ${fails === 0 && consoleErrors.length === 0 ? "TODO OK" : `${fails} fallo(s), ${consoleErrors.length} error(es) de consola`} ---`);
process.exit(fails === 0 && consoleErrors.length === 0 ? 0 : 1);
