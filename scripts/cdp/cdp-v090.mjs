// Verificación E2E de v0.9.0 contra la app real (dev o binario de producción):
// About, Ctrl+Enter, Ctrl+clic, centro colapsado/expandido, lista de Etiquetas,
// pull/push por rama no activa, tags remotos, botón "⋯", y el hueco histórico
// del proyecto — fetch/pull/push, stash y cherry-pick — que nunca tuvo un
// script E2E persistido.
//
// Autocontenido: crea sus repos de prueba (un bare + dos clones) en el
// directorio temporal y los borra. Respalda y RESTAURA `localStorage` (vía
// `_ls.mjs`). Sale con código 1 si falla un check o hay un error de
// consola/excepción.
//
//   node cdp-v090.mjs            (puerto CDP 9222, o CDP_PORT=...)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepLocalStorage } from "./_ls.mjs";
import { installDialogMock } from "./_dialog-mock.mjs";

const PORT = process.env.CDP_PORT ?? "9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixtures ----------
const base = mkdtempSync(join(tmpdir(), "gitpad-v090-"));
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8" }).trim();
function initRepo(name) {
  const dir = join(base, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  // Sin esto, `core.autocrlf` global de Windows normaliza a CRLF en
  // operaciones tipo `stash pop`/checkout, y una comparación de contenido
  // exacto contra lo escrito con `\n` falla por algo ajeno al producto.
  git(dir, "config", "core.autocrlf", "false");
  return dir;
}
const put = (dir, rel, content) => {
  const p = join(dir, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};

// Bare origin + clone A (la que abre la UI) + clone B (segunda "máquina" que
// avanza feat/master para dar algo real que traer con fetch/pull/topbar).
const origin = join(base, "origin.git");
mkdirSync(origin);
git(origin, "init", "-q", "--bare", "-b", "master");

const A = initRepo("a");
put(A, "f.txt", "0\n");
git(A, "add", "-A");
git(A, "commit", "-q", "-m", "inicial");
git(A, "remote", "add", "origin", origin);
git(A, "push", "-q", "-u", "origin", "master");
git(A, "branch", "feat"); // sin checkout, sin upstream todavía
git(A, "branch", "v1");
git(A, "tag", "v1"); // tag y rama homónimos en el mismo commit
// Rama para cherry-pick: un commit que NO está en master.
git(A, "checkout", "-q", "-b", "otra");
put(A, "cp.txt", "cherry\n");
git(A, "add", "-A");
git(A, "commit", "-q", "-m", "commit para cherry-pick");
const cherryHash = git(A, "rev-parse", "HEAD");
git(A, "checkout", "-q", "master");
const rootA = git(A, "rev-parse", "--show-toplevel");

execFileSync("git", ["clone", "-q", origin, join(base, "b")]);
const B = join(base, "b");
git(B, "config", "user.email", "t2@t.t");
git(B, "config", "user.name", "t2");
// B avanza master (para Fetch/Pull de la topbar); feat se sincroniza más
// abajo, después de que A la suba al remoto por primera vez desde la UI.
put(B, "g.txt", "0\n");
git(B, "add", "-A");
git(B, "commit", "-q", "-m", "de b en master");
git(B, "push", "-q", "origin", "master");

// Repo C: SIN remoto configurado, para el caso de doDeleteTag que no debe
// preguntar por el borrado remoto (fallaría siempre).
const C = initRepo("c");
put(C, "x.txt", "0\n");
git(C, "add", "-A");
git(C, "commit", "-q", "-m", "inicial C");
git(C, "tag", "solo-local");
const rootC = git(C, "rev-parse", "--show-toplevel");

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
async function reloadWith(tabs, active) {
  await ev(`(() => {
    localStorage.setItem('gitpad:tabs', ${JSON.stringify(JSON.stringify(tabs))});
    localStorage.setItem('gitpad:active', ${JSON.stringify(active)});
    return 1; })()`);
  await send("Page.reload", { ignoreCache: true });
  await sleep(800);
  await waitFor("document.querySelector('.commit') ? 1 : null");
  // Diálogos nativos: confirm siempre acepta, prompt vacío, alert no bloquea
  // (About lo usa). Un array `__ca` permite encolar respuestas de confirm
  // distintas cuando hace falta (p. ej. doDeleteTag pregunta dos veces).
  await installDialogMock(ev);
}
const msgs = () => ev("window.__msgs ?? []");
const setConfirms = (arr) => ev(`(() => { window.__ca = ${JSON.stringify(arr)}; return 1; })()`);
const setPrompt = (v) => ev(`(() => { window.__pa = ${JSON.stringify(v)}; return 1; })()`);
/** Cola de elecciones para chooseAction (diálogo de 3 botones): 0=yes, 1=no, 2=cancel. */
const setChoices = (arr) => ev(`(() => { window.__cc = ${JSON.stringify(arr)}; return 1; })()`);
const clickBtn = (scope, text) =>
  ev(`(() => {
    const b = Array.from(document.querySelectorAll(${JSON.stringify(scope + " button")}))
      .find((x) => x.textContent.trim() === ${JSON.stringify(text)});
    if (!b || b.disabled) return false;
    b.click(); return true; })()`);
// El botón de About es un SVG sin texto (ver Backlog "icono ⓘ pixelado");
// se localiza por selector, no por textContent como el resto de clickBtn.
const clickSel = (selector) =>
  ev(`(() => {
    const b = document.querySelector(${JSON.stringify(selector)});
    if (!b || b.disabled) return false;
    b.click(); return true; })()`);
const btnDisabled = (scope, text) =>
  ev(`(() => {
    const b = Array.from(document.querySelectorAll(${JSON.stringify(scope + " button")}))
      .find((x) => x.textContent.trim() === ${JSON.stringify(text)});
    return b ? b.disabled : null; })()`);
function openRowMenu(group, name) {
  return ev(`(() => {
    const label = Array.from(document.querySelectorAll('.branch-group-label')).find((e) => e.textContent === ${JSON.stringify(group)});
    if (!label) return false;
    const rows = Array.from(label.parentElement.querySelectorAll('.branch-item'));
    const row = rows.find((r) => r.querySelector('.branch-name')?.textContent === ${JSON.stringify(name)});
    if (!row) return false;
    row.querySelector('.branch-menu').click();
    return true; })()`);
}
const menuLabels = () => ev("Array.from(document.querySelectorAll('.ctx-menu button')).map((b) => b.textContent.trim())");
const menuItemDisabled = (label) =>
  ev(`Array.from(document.querySelectorAll('.ctx-menu button')).find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.disabled ?? null`);
const clickMenuItem = (label) =>
  ev(`(() => { const b = Array.from(document.querySelectorAll('.ctx-menu button')).find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
const closeMenu = () => ev("document.body.click(); true");
const lastError = () => ev("document.querySelector('.error')?.textContent ?? null");

try {
  await reloadWith([rootA], rootA);

  // ===== 1. About =====
  console.log("\n# 1. About");
  const pkgVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).version;
  await clickSel(".about-btn");
  await sleep(150);
  check("About muestra la versión de package.json", (await msgs()).some((m) => m.includes(pkgVersion)), JSON.stringify(await msgs()));

  // ===== 2. Fetch/Pull de la topbar (hueco histórico) =====
  // Antes de que A comitee nada más en master: así el Pull es un
  // fast-forward real (B ya la adelantó al clonar), no una divergencia.
  console.log("\n# 2. Fetch/Pull (topbar, rama activa)");
  await clickBtn(".topbar", "Fetch");
  await sleep(1000);
  check("Fetch sin error", (await lastError()) === null);
  const masterBefore = git(A, "rev-parse", "master");
  await clickBtn(".topbar", "Pull");
  await sleep(1000);
  check("Pull sin error", (await lastError()) === null);
  check("master avanzó (trajo el commit de b)", git(A, "rev-parse", "master") !== masterBefore);

  // ===== 3. Ctrl+Enter commitea =====
  console.log("\n# 3. Ctrl+Enter");
  put(A, "f.txt", "1\n");
  // Sin watcher de filesystem: hace falta recargar para que la app note el
  // cambio en disco (mismo truco que `reloadWith`, no el botón "Recargar").
  await reloadWith([rootA], rootA);
  await waitFor("Array.from(document.querySelectorAll('.entry')).some((e) => e.textContent.includes('f.txt')) ? 1 : null");
  await clickBtn(".status", "Stage all");
  await waitFor("document.querySelector('.commit-subject-input') ? 1 : null");
  await ev(`(() => {
    const input = document.querySelector('.commit-subject-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'commit por Ctrl+Enter');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 1; })()`);
  await ev(`(() => {
    const ta = document.querySelector('.commitbox textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    return 1; })()`);
  await sleep(600);
  check("Ctrl+Enter commiteó de verdad", git(A, "log", "-1", "--format=%s") === "commit por Ctrl+Enter");

  // ===== 4. Centro colapsado/expandido + Ctrl+clic =====
  console.log("\n# 4. Colapso del centro");
  check("colapsado sin selección", await ev("document.querySelector('.body').classList.contains('diff-collapsed')"));
  await ev("document.querySelector('.commit:not(.wip)').click(); true");
  await sleep(300);
  check("expandido tras seleccionar un commit", (await ev("document.querySelector('.body').classList.contains('diff-collapsed')")) === false);
  await ev("document.querySelector('.commit.sel').click(); true"); // reclic (sin Ctrl) también deselecciona
  await sleep(300);
  check("reclic (sin Ctrl) deselecciona y colapsa", await ev("document.querySelector('.body').classList.contains('diff-collapsed')"));
  await ev("document.querySelector('.commit:not(.wip)').click(); true");
  await sleep(300);
  await ev("document.querySelector('.commit.sel').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); true");
  await sleep(300);
  check("Ctrl+clic deselecciona y vuelve a colapsar", await ev("document.querySelector('.body').classList.contains('diff-collapsed')"));

  // ===== 5. Etiquetas: lista + menú =====
  console.log("\n# 5. Etiquetas");
  const tagNames = await ev(`(() => {
    const label = Array.from(document.querySelectorAll('.branch-group-label')).find((e) => e.textContent === 'Etiquetas');
    return label ? Array.from(label.parentElement.querySelectorAll('.branch-name')).map((e) => e.textContent) : null; })()`);
  check("Etiquetas lista v1 (pese a la rama homónima)", Array.isArray(tagNames) && tagNames.includes("v1"), JSON.stringify(tagNames));
  const menuOpacity = await ev(`getComputedStyle(document.querySelector('.branch-item .branch-menu')).opacity`);
  check("el botón ⋯ no está oculto (opacity != 0)", menuOpacity !== "0", menuOpacity);

  await openRowMenu("Etiquetas", "v1");
  await sleep(200);
  const tagMenu = await menuLabels();
  check("menú de v1 trae las acciones remotas", tagMenu.includes("Push") && tagMenu.includes("Borrar del remoto…"), JSON.stringify(tagMenu));
  await clickMenuItem("Push");
  await sleep(1000);
  check("push del tag v1 sin error", (await lastError()) === null);
  git(A, "fetch", "-q", "origin");
  check("v1 llegó al remoto (fetch la ve)", git(A, "ls-remote", "origin", "refs/tags/v1").length > 0);

  // Borrar: un solo diálogo de 3 botones (con remoto), elegir "En local y
  // en el remoto" (índice 0 = yes).
  await openRowMenu("Etiquetas", "v1");
  await sleep(200);
  await setChoices([0]);
  await clickMenuItem("Borrar…");
  await sleep(1000);
  check("borrar tag local+remoto: una sola pregunta", (await msgs()).length === 1, JSON.stringify(await msgs()));
  check("borrar tag local+remoto sin error", (await lastError()) === null);
  git(A, "fetch", "-q", "origin", "--prune", "--prune-tags");
  check("v1 ya no está en el remoto", git(A, "ls-remote", "origin", "refs/tags/v1").length === 0);

  // Elegir "Solo en local" (índice 1 = no): el remoto NO se toca.
  git(A, "tag", "v2");
  await clickBtn(".topbar", "Recargar"); // v2 se creó por git, no por la UI: no está en el estado de React todavía
  await sleep(500);
  const opened = await openRowMenu("Etiquetas", "v2");
  check("v2 aparece en Etiquetas tras Recargar", opened);
  await sleep(200);
  await clickMenuItem("Push");
  await sleep(1000);
  git(A, "fetch", "-q", "origin");
  check("v2 llegó al remoto antes de la prueba", git(A, "ls-remote", "origin", "refs/tags/v2").length > 0);
  await openRowMenu("Etiquetas", "v2");
  await sleep(200);
  await setChoices([1]);
  await clickMenuItem("Borrar…");
  await sleep(1000);
  check("borrar tag solo local: sin error", (await lastError()) === null);
  // No se asume que el grupo "Etiquetas" siga en el DOM: v1 ya se borró
  // arriba, así que borrar v2 puede dejar CERO tags y el grupo entero
  // desaparece (el panel no pinta una sección vacía) — se comprueba contra
  // git, no contra un elemento que puede no existir.
  check("borrar tag solo local: ya no está en git local", git(A, "tag", "--list", "v2") === "");
  git(A, "fetch", "-q", "origin");
  check("borrar tag solo local: SIGUE en el remoto", git(A, "ls-remote", "origin", "refs/tags/v2").length > 0);

  // ===== 5b. doDeleteTag en un repo SIN remoto: no debe preguntar dos veces =====
  console.log("\n# 5b. Borrar tag sin remoto configurado");
  await reloadWith([rootC], rootC);
  await setConfirms([true]); // una sola respuesta en la cola: si pregunta dos veces, la segunda usa el default (true) y no lo detectaríamos — se mide el número de mensajes, no solo el resultado.
  await openRowMenu("Etiquetas", "solo-local");
  await sleep(200);
  await clickMenuItem("Borrar…");
  await sleep(800);
  const msgsNoRemote = await msgs();
  check("una sola confirmación (sin preguntar por el remoto)", msgsNoRemote.length === 1, JSON.stringify(msgsNoRemote));
  check("sin error", (await lastError()) === null);
  const tagsAfterDelete = await ev(`(() => {
    const label = Array.from(document.querySelectorAll('.branch-group-label')).find((e) => e.textContent === 'Etiquetas');
    return label ? Array.from(label.parentElement.querySelectorAll('.branch-name')).map((e) => e.textContent) : []; })()`);
  check("la lista se refrescó (el tag ya no aparece)", !tagsAfterDelete.includes("solo-local"), JSON.stringify(tagsAfterDelete));
  await reloadWith([rootA], rootA);

  // ===== 6. Pull/push por rama no activa =====
  console.log("\n# 6. Pull/push por rama (feat, no activa)");
  await openRowMenu("Locales", "feat");
  await sleep(200);
  check("Pull deshabilitado sin upstream", await menuItemDisabled("Pull"));
  await clickMenuItem("Push"); // push_new_branch: fija upstream
  await sleep(1000);
  check("push de feat sin upstream, sin error", (await lastError()) === null);
  check("origin/feat existe tras el push", git(A, "ls-remote", "origin", "refs/heads/feat").length > 0);

  // B avanza feat de verdad para que el Pull por menú traiga algo real.
  git(B, "fetch", "-q", "origin");
  git(B, "checkout", "-q", "-B", "feat", "origin/feat");
  put(B, "h.txt", "0\n");
  git(B, "add", "-A");
  git(B, "commit", "-q", "-m", "de b en feat");
  git(B, "push", "-q", "origin", "feat");

  await openRowMenu("Locales", "feat");
  await sleep(200);
  check("Pull habilitado tras fijar upstream", (await menuItemDisabled("Pull")) === false);
  const featBefore = git(A, "rev-parse", "feat");
  await clickMenuItem("Pull");
  await sleep(1000);
  check("pull de feat sin error", (await lastError()) === null);
  check("feat avanzó (trajo el commit de b)", git(A, "rev-parse", "feat") !== featBefore);

  // ===== 7. Botón "⋯" activado por teclado se posiciona por el rect =====
  // Un Enter/Espacio real sobre un <button> con foco dispara un "click" con
  // clientX/Y en 0 — se reproduce ese evento tal cual, en vez de depender de
  // que la síntesis de teclado de CDP dispare la activación nativa en
  // WebView2 (frágil). Es justo la condición que mira `openMenu` en App.tsx.
  console.log("\n# 7. Botón ⋯ por teclado");
  await ev(`(() => {
    const label = Array.from(document.querySelectorAll('.branch-group-label')).find((e) => e.textContent === 'Locales');
    const row = Array.from(label.parentElement.querySelectorAll('.branch-item')).find((r) => r.querySelector('.branch-name')?.textContent === 'master');
    const btn = row.querySelector('.branch-menu');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    return 1; })()`);
  await sleep(300);
  const menuPos = await ev("(() => { const m = document.querySelector('.ctx-menu'); return m ? { x: parseFloat(m.style.left), y: parseFloat(m.style.top) } : null; })()");
  check("el menú activado con clientX/Y=0 no queda clavado en (0,0)", menuPos !== null && !(menuPos.x === 0 && menuPos.y === 0), JSON.stringify(menuPos));
  await closeMenu();

  // ===== 8. Hueco histórico: Push de la topbar =====
  // Fetch/Pull ya se probaron en la sección 2, antes de la primera
  // divergencia posible con master.
  console.log("\n# 8. Push (topbar, rama activa)");
  put(A, "z.txt", "0\n");
  await reloadWith([rootA], rootA);
  await waitFor("Array.from(document.querySelectorAll('.entry')).some((e) => e.textContent.includes('z.txt')) ? 1 : null");
  await clickBtn(".status", "Stage all");
  await waitFor("document.querySelector('.commit-subject-input') ? 1 : null");
  await ev(`(() => {
    const input = document.querySelector('.commit-subject-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'commit para push de topbar');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 1; })()`);
  await clickBtn(".commitbox", "Commit");
  await sleep(600);
  const masterRemoteBefore = git(origin, "rev-parse", "master");
  await clickBtn(".topbar", "Push");
  await sleep(1000);
  check("Push sin error", (await lastError()) === null);
  check("el remoto recibió el push", git(origin, "rev-parse", "master") !== masterRemoteBefore);

  // ===== 9. Stash =====
  console.log("\n# 9. Stash");
  put(A, "f.txt", "cambio sin comprometer\n");
  await reloadWith([rootA], rootA);
  await waitFor("Array.from(document.querySelectorAll('.entry')).some((e) => e.textContent.includes('f.txt')) ? 1 : null");
  const stashClicked = await clickBtn(".topbar", "Stash"); // stash push (sin mensaje) de la topbar
  check("botón Stash de la topbar habilitado y clicado", stashClicked);
  // El botón "Pop" (aplica el stash 0 y lo quita) queda deshabilitado hasta
  // que el push anterior actualiza `active.stashes` — sin esperar, un clic
  // que no hace nada pasaría el check de "sin error" en falso positivo.
  await waitFor("(document.querySelector('.status .stash-item') || (Array.from(document.querySelectorAll('.topbar button')).find((b) => b.textContent.trim() === 'Pop' && !b.disabled))) ? 1 : null");
  check("stash guardado sin error", (await lastError()) === null);
  check("el árbol de trabajo queda limpio tras el stash", git(A, "status", "--porcelain").length === 0);
  const popClicked = await clickBtn(".topbar", "Pop"); // aplica el más reciente y lo quita de la lista
  await sleep(800);
  check("botón Pop habilitado y clicado", popClicked);
  check("stash aplicado (Pop) sin error", (await lastError()) === null);
  check("f.txt vuelve a tener el cambio", readFileSync(join(A, "f.txt"), "utf8") === "cambio sin comprometer\n");
  git(A, "checkout", "--", "f.txt");

  // ===== 10. Cherry-pick =====
  // Ya estamos en master (el commit de "otra" no está aquí): el botón ⤵ de
  // ese commit en el grafo (--all, se ven todas las ramas) lo trae sin
  // cambiar de rama.
  console.log("\n# 10. Cherry-pick");
  await waitFor(`Array.from(document.querySelectorAll('.commit')).some((r) => r.textContent.includes('commit para cherry-pick')) ? 1 : null`);
  const gotCherry = await ev(`(() => {
    const row = Array.from(document.querySelectorAll('.commit')).find((r) => r.textContent.includes('commit para cherry-pick'));
    const btn = row?.querySelector('.cherry-btn');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true; })()`);
  await sleep(1000);
  check("botón de cherry-pick encontrado y clicado", gotCherry);
  check("cherry-pick sin error", (await lastError()) === null);
  check("el commit de cherry-pick llegó a master", git(A, "log", "--format=%s").includes("commit para cherry-pick"));

  // ===== 11. Selección persiste tras reload (stage/unstage/commit) =====
  // Antes de este cambio, `reload()` siempre limpiaba `sel`: cada stage,
  // unstage o commit colapsaba el centro y el panel derecho volvía a su
  // ancho de "colapsado" — Bernardo tenía que reseleccionar cada vez.
  console.log("\n# 11. Selección persiste tras reload");
  put(A, "sel1.txt", "uno\n");
  put(A, "sel2.txt", "dos\n");
  await reloadWith([rootA], rootA);
  await waitFor("Array.from(document.querySelectorAll('.entry')).some((e) => e.textContent.includes('sel1.txt')) ? 1 : null");
  // 11a. Archivo sin preparar seleccionado → se hace stage de OTRO archivo →
  // sigue seleccionado en Unstaged, centro sigue expandido, mismo ancho.
  await ev(`(() => {
    const row = Array.from(document.querySelectorAll('.entry')).find((e) => e.textContent.includes('sel1.txt'));
    row.click(); return 1; })()`);
  await sleep(300);
  check("11a. sel1.txt queda seleccionado (Unstaged)", await ev("document.querySelector('.entry.sel')?.textContent.includes('sel1.txt')"));
  const widthBeforeStage = await ev("document.querySelector('.diffpane')?.getBoundingClientRect().width ?? null");
  await ev(`(() => {
    const row = Array.from(document.querySelectorAll('.entry')).find((e) => e.textContent.includes('sel2.txt'));
    row.querySelector('button')?.click(); return 1; })()`); // stage de sel2.txt (botón ＋ de esa fila)
  await sleep(500);
  // Guardián de no-vacuidad: si el clic no llegó a disparar `toggleStage`,
  // todo lo de abajo pasaría en falso (nada habría cambiado de verdad).
  check("11a. sel2.txt SÍ quedó preparado de verdad (git)", git(A, "diff", "--cached", "--name-only").split("\n").includes("sel2.txt"));
  check("11a. tras stage de OTRO archivo, sel1.txt sigue seleccionado", await ev("document.querySelector('.entry.sel')?.textContent.includes('sel1.txt')"));
  check("11a. centro no colapsa", (await ev("document.querySelector('.body').classList.contains('diff-collapsed')")) === false);
  const widthAfterStage = await ev("document.querySelector('.diffpane')?.getBoundingClientRect().width ?? null");
  check("11a. el panel derecho no salta de ancho", Math.abs(widthAfterStage - widthBeforeStage) < 2, `${widthBeforeStage} -> ${widthAfterStage}`);

  // 11b. El propio archivo seleccionado cambia de lado (se le hace stage a
  // ÉL): se sigue al lado Staged, no se pierde la selección, y su diff se
  // vuelve a pedir de verdad (no se queda vacío por una carrera con `sel`
  // leído del updater de `setTabs` en vez de un valor ya resuelto).
  await ev(`(() => {
    const row = Array.from(document.querySelectorAll('.entry')).find((e) => e.textContent.includes('sel1.txt'));
    row.querySelector('button')?.click(); return 1; })()`);
  await sleep(500);
  check("11b. sel1.txt SÍ quedó preparado de verdad (git)", git(A, "diff", "--cached", "--name-only").split("\n").includes("sel1.txt"));
  const sel1bSection = await ev(`(() => {
    const row = document.querySelector('.entry.sel');
    if (!row || !row.textContent.includes('sel1.txt')) return 'lost';
    return row.closest('ul')?.previousElementSibling?.querySelector('h3')?.textContent ?? 'sin-cabecera'; })()`);
  check("11b. sel1.txt se sigue al lado Staged", sel1bSection === "Staged", sel1bSection);
  check("11b. centro sigue expandido", (await ev("document.querySelector('.body').classList.contains('diff-collapsed')")) === false);
  await waitFor("document.querySelector('.diffpane')?.textContent.includes('uno') ? 1 : null");
  check("11b. el diff SÍ se recargó (contenido real, no vacío)", await ev("document.querySelector('.diffpane')?.textContent.includes('uno')"));

  // 11c. Un commit seleccionado sobrevive a una recarga real (botón
  // "Recargar", siempre visible). El panel derecho, mientras haya un commit
  // seleccionado, muestra "Archivos del commit" en vez de "Cambios" (no hay
  // forma de ver el árbol de trabajo ahí) — la prueba de que la recarga trajo
  // datos frescos de verdad usa el panel de RAMAS (izquierda, siempre visible
  // pase lo que pase con `sel`): crear una rama por git y comprobar que
  // aparece en la lista tras "Recargar".
  // Nota: crear una rama nueva en HEAD añade un chip de ref a esa misma fila,
  // así que comparar por `textContent` de toda la fila daría un falso
  // negativo — se usa el hash corto de `.commit-meta code`, que no cambia.
  const commitHash = () => ev("document.querySelector('.commit.sel .commit-meta code')?.textContent ?? null");
  await ev("document.querySelector('.commit:not(.wip)').click(); true");
  await sleep(300);
  const commitSelHash = await commitHash();
  git(A, "branch", "recien-creada-11c");
  const refreshClicked = await clickBtn(".topbar", "Recargar");
  check("11c. el botón «Recargar» estaba habilitado y se clicó", refreshClicked);
  await waitFor("Array.from(document.querySelectorAll('.branch-name')).some((e) => e.textContent === 'recien-creada-11c') ? 1 : null");
  check("11c. la recarga SÍ trajo la rama nueva (prueba de que no fue vacía)", await ev("Array.from(document.querySelectorAll('.branch-name')).some((e) => e.textContent === 'recien-creada-11c')"));
  check("11c. el commit sigue seleccionado tras Recargar", await ev("document.querySelector('.commit.sel') ? 1 : null"));
  check("11c. sigue siendo EL MISMO commit", (await commitHash()) === commitSelHash, `${commitSelHash} -> ${await commitHash()}`);
  check("11c. centro sigue expandido", (await ev("document.querySelector('.body').classList.contains('diff-collapsed')")) === false);
  git(A, "branch", "-D", "recien-creada-11c"); // limpiar: deja el repo listo para lo que venga después.

  // ===== 12. Mensaje de divergencia real (Pull, rama activa) =====
  // Fixture propio y aislado (no reutiliza A/B: tras 11 tandas su historia
  // real ya no es la que parece por el código de arriba). `pull --ff-only`
  // (repo.rs) rechaza una divergencia de verdad; antes esto mostraba el
  // stderr crudo de git, ahora pasa por friendlyGitError.
  console.log("\n# 12. Mensaje de divergencia (Pull real)");
  const originDiv = join(base, "origin-div.git");
  mkdirSync(originDiv);
  git(originDiv, "init", "-q", "--bare", "-b", "master");
  const D1 = initRepo("div1");
  put(D1, "d.txt", "0\n");
  git(D1, "add", "-A");
  git(D1, "commit", "-q", "-m", "base");
  git(D1, "remote", "add", "origin", originDiv);
  git(D1, "push", "-q", "-u", "origin", "master");
  execFileSync("git", ["clone", "-q", originDiv, join(base, "div2")]);
  const D2 = join(base, "div2");
  git(D2, "config", "user.email", "t3@t.t");
  git(D2, "config", "user.name", "t3");
  put(D2, "d.txt", "desde d2\n");
  git(D2, "commit", "-qam", "diverge en d2");
  git(D2, "push", "-q", "origin", "master");
  put(D1, "d.txt", "desde d1\n");
  git(D1, "commit", "-qam", "diverge en d1");
  const rootD1 = git(D1, "rev-parse", "--show-toplevel");
  await reloadWith([rootD1], rootD1);
  await clickBtn(".topbar", "Pull");
  await sleep(1000);
  const divMsg = await lastError();
  check("Pull divergente: el mensaje traducido, no el stderr crudo", divMsg?.includes("No se puede hacer Pull") ?? false, divMsg ?? "null");
  check("Pull divergente: no menciona el hint crudo de git", divMsg ? !divMsg.includes("Diverging branches") : false, divMsg ?? "null");

  check("sin errores de consola", consoleErrors.length === 0, consoleErrors.join(" | "));
} finally {
  await restoreLS();
  ws.close();
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nerrores de consola: ${consoleErrors.length}`);
consoleErrors.forEach((e) => console.log("  -", e));
console.log(`--- fin: ${fails === 0 && consoleErrors.length === 0 ? "TODO OK" : `${fails} fallo(s), ${consoleErrors.length} error(es) de consola`} ---`);
process.exit(fails === 0 && consoleErrors.length === 0 ? 0 : 1);
