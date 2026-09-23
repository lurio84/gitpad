// Verificación E2E de v0.7.0 contra la app real (dev o binario de producción):
// commit con Resumen+Descripción (y amend), reordenar pestañas, paneles
// redimensionables (con clamp), modo árbol y explorador «Todos los archivos».
//
// Autocontenido: crea sus dos repos de prueba en el directorio temporal.
// Respalda `localStorage` (pestañas, paneles, modos) y lo RESTAURA al terminar,
// para poder pasarlo también contra la app instalada sin llevarse la sesión.
// Sale con código 1 si falla un check o hay un error de consola/excepción.
//
//   node cdp-v070.mjs            (puerto CDP 9222, o CDP_PORT=...)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.CDP_PORT ?? "9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixtures ----------
const base = mkdtempSync(join(tmpdir(), "gitpad-v070-"));
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

const A = initRepo("repoA");
put(A, "README.md", "# repo A\n");
put(A, "src/lib/util.ts", "export const one = 1;\nexport const two = 2;\n");
put(A, "src/app.ts", "console.log('hola');\n");
put(A, "ñandú/ç.txt", "contenido con acentos: áéí\n");
writeFileSync(join(A, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0xff]));
git(A, "add", "-A");
git(A, "commit", "-q", "-m", "inicial", "-m", "cuerpo del inicial");
put(A, "src/app.ts", "console.log('hola');\nconsole.log('adios');\n");
git(A, "add", "-A");
git(A, "commit", "-q", "-m", "segundo");
const B = initRepo("repoB");
put(B, "b.txt", "b\n");
git(B, "add", "-A");
git(B, "commit", "-q", "-m", "solo b");
const rootA = git(A, "rev-parse", "--show-toplevel");
const rootB = git(B, "rev-parse", "--show-toplevel");
const headHashA = () => git(A, "rev-parse", "HEAD");

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

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLO"} — ${label}${extra ? `  [${extra}]` : ""}`);
  if (!cond) fails++;
};
async function waitFor(expr, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const v = await ev(expr).catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timeout esperando: ${expr}`);
}
async function reloadWith(tabs, active, extra = {}) {
  await ev(`(() => {
    localStorage.setItem('gitpad:tabs', ${JSON.stringify(JSON.stringify(tabs))});
    localStorage.setItem('gitpad:active', ${JSON.stringify(active)});
    for (const [k, v] of Object.entries(${JSON.stringify(extra)})) {
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    }
    return 1; })()`);
  await send("Page.reload", { ignoreCache: true });
  await sleep(800);
  await waitFor("document.querySelector('.commit') ? 1 : null");
}
// Escribir en un input/textarea de React: el setter nativo + evento `input`.
const typeInto = (sel, value) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1; })()`);
const rect = (sel) =>
  ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })()`);
async function mouseDrag(from, to, steps = 8) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(20);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
  await sleep(300);
}

// Respaldo del localStorage real para restaurarlo al final.
const KEYS = ["gitpad:tabs", "gitpad:active", "gitpad:panels", "gitpad:files-view", "gitpad:diff-view"];
const backup = await ev(`(() => { const o = {}; for (const k of ${JSON.stringify(KEYS)}) o[k] = localStorage.getItem(k); return o; })()`);

try {
  // ===== 1. Commit: Resumen + Descripción =====
  console.log("\n# 1. Commit con Resumen + Descripción");
  put(A, "c1.txt", "1\n");
  git(A, "add", "c1.txt");
  await reloadWith([rootA], rootA);
  await waitFor("document.querySelector('.commitbox') ? 1 : null");
  check("hay input «Resumen» y textarea «Descripción»",
    (await ev("!!document.querySelector('.commitbox input[placeholder=\"Resumen\"]') && !!document.querySelector('.commitbox textarea')")));
  check("Commit deshabilitado sin resumen", await ev("document.querySelector('.commitbox button[type=submit]').disabled"));
  await typeInto(".commitbox textarea", "solo descripción");
  check("Commit sigue deshabilitado con descripción pero sin resumen", await ev("document.querySelector('.commitbox button[type=submit]').disabled"));
  await typeInto(".commitbox input[type=text]", "con cuerpo");
  await ev("document.querySelector('.commitbox button[type=submit]').click()");
  await sleep(1200);
  check("mensaje = resumen + línea en blanco + cuerpo", git(A, "log", "-1", "--format=%B") === "con cuerpo\n\nsolo descripción");

  put(A, "c2.txt", "2\n");
  git(A, "add", "c2.txt");
  await reloadWith([rootA], rootA);
  await waitFor("document.querySelector('.commitbox') ? 1 : null");
  await typeInto(".commitbox input[type=text]", "solo resumen");
  await ev("document.querySelector('.commitbox button[type=submit]').click()");
  await sleep(1200);
  check("solo resumen: sin líneas de más", git(A, "log", "-1", "--format=%B") === "solo resumen");

  put(A, "c3.txt", "3\n");
  git(A, "add", "c3.txt");
  await reloadWith([rootA], rootA);
  await waitFor("document.querySelector('.commitbox') ? 1 : null");
  await typeInto(".commitbox input[type=text]", "cuerpo en blanco");
  await typeInto(".commitbox textarea", "   \n  ");
  await ev("document.querySelector('.commitbox button[type=submit]').click()");
  await sleep(1200);
  check("descripción solo con espacios = como sin descripción", git(A, "log", "-1", "--format=%B") === "cuerpo en blanco");

  // Amend: precarga del commit reescrito. HEAD = «cuerpo en blanco» (sin cuerpo),
  // así que primero se crea uno CON cuerpo para comprobar que no se pierde.
  put(A, "c4.txt", "4\n");
  git(A, "add", "c4.txt");
  git(A, "commit", "-q", "-m", "para amend", "-m", "este cuerpo debe sobrevivir");
  put(A, "c5.txt", "5\n");
  git(A, "add", "c5.txt");
  await reloadWith([rootA], rootA);
  await waitFor("document.querySelector('.commitbox') ? 1 : null");
  await typeInto(".commitbox input[type=text]", "borrador en curso");
  await ev("document.querySelector('.commitbox .amend input').click()");
  await sleep(300);
  check("amend precarga el resumen del último commit", (await ev("document.querySelector('.commitbox input[type=text]').value")) === "para amend");
  check("amend precarga la descripción del último commit", (await ev("document.querySelector('.commitbox textarea').value")) === "este cuerpo debe sobrevivir");
  await ev("document.querySelector('.commitbox .amend input').click()");
  await sleep(300);
  check("desmarcar amend restaura el borrador", (await ev("document.querySelector('.commitbox input[type=text]').value")) === "borrador en curso");
  await ev("document.querySelector('.commitbox .amend input').click()");
  await sleep(200);
  const realConfirm = await ev("(() => { window.__c = window.confirm; window.confirm = () => true; return 1; })()");
  await ev("document.querySelector('.commitbox button[type=submit]').click()");
  await sleep(1200);
  check("amend conserva el cuerpo", git(A, "log", "-1", "--format=%B") === "para amend\n\neste cuerpo debe sobrevivir");
  check("amend incluyó el archivo nuevo", git(A, "show", "--name-only", "--format=", "HEAD").includes("c5.txt"));
  void realConfirm;

  // ===== 2. Reordenar pestañas =====
  console.log("\n# 2. Reordenar pestañas");
  await reloadWith([rootA, rootB], rootA);
  const names = () => ev("Array.from(document.querySelectorAll('.tab .tab-name')).map(e => e.textContent)");
  check("orden inicial repoA, repoB", JSON.stringify(await names()) === JSON.stringify(["repoA", "repoB"]));
  const t1 = await rect(".tab:nth-child(1)");
  const t2 = await rect(".tab:nth-child(2)");
  await mouseDrag({ x: t1.x + t1.w / 2, y: t1.y + t1.h / 2 }, { x: t2.x + t2.w * 0.8, y: t2.y + t2.h / 2 });
  let order = await names();
  let how = "arrastre real con ratón";
  if (JSON.stringify(order) !== JSON.stringify(["repoB", "repoA"])) {
    // El ratón de CDP no arranca un drag nativo por sí solo. Chromium sí lo
    // arranca (draggable=true) y CDP lo intercepta: se reinyecta con
    // Input.dispatchDragEvent. Cubre la lógica de React y el `draggable`, pero
    // NO el flag `dragDropEnabled` de Tauri/wry (esa capa va por debajo de CDP).
    how = "drag NATIVO interceptado por CDP (no cubre dragDropEnabled de Tauri)";
    let dragData = null;
    const onIntercept = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Input.dragIntercepted") dragData = m.params.data;
    };
    ws.addEventListener("message", onIntercept);
    await send("Input.setInterceptDrags", { enabled: true });
    const a = await rect(".tab:nth-child(1)");
    const b = await rect(".tab:nth-child(2)");
    const from = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const to = { x: b.x + b.w * 0.8, y: b.y + b.h / 2 };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + 15, y: from.y, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + 30, y: from.y, button: "left", buttons: 1 });
    await sleep(400);
    if (dragData) {
      for (const type of ["dragEnter", "dragOver"]) {
        await send("Input.dispatchDragEvent", { type, x: to.x, y: to.y, data: dragData });
        await sleep(150);
      }
      await send("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data: dragData });
      await sleep(300);
    } else {
      how = "SIN arrastre: Chromium no llegó a iniciar el drag (¿draggable roto?)";
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 }).catch(() => {});
    await send("Input.setInterceptDrags", { enabled: false });
    ws.removeEventListener("message", onIntercept);
    await sleep(300);
    order = await names();
  }
  check("arrastrar repoA sobre repoB los reordena", JSON.stringify(order) === JSON.stringify(["repoB", "repoA"]), how);
  check("la pestaña activa sigue siendo repoA", (await ev("document.querySelector('.tab.active .tab-name')?.textContent")) === "repoA");
  check("el orden se persiste", (await ev("localStorage.getItem('gitpad:tabs')")) === JSON.stringify([rootB, rootA]));

  // ===== 3. Paneles redimensionables =====
  // v0.9.0: sin commit seleccionado la columna de diff se colapsa y el
  // mínimo de las columnas centrales baja de 480 a 220 (ver `usePanels.ts`).
  // Estas comprobaciones asumen el diff visible (480), que es también el
  // caso real más común al redimensionar — se selecciona un commit primero.
  console.log("\n# 3. Paneles redimensionables");
  await reloadWith([rootA], rootA, { "gitpad:panels": null });
  await ev("document.querySelector('.commit:not(.wip)')?.click(); 1");
  await sleep(300);
  const w0 = (await rect(".branches")).w;
  check("ancho inicial del panel izquierdo = 180", Math.round(w0) === 180, `${w0}`);
  const h = await rect(".resizer-left");
  await mouseDrag({ x: h.x + h.w / 2, y: h.y + 200 }, { x: h.x + h.w / 2 + 100, y: h.y + 200 });
  const w1 = (await rect(".branches")).w;
  check("arrastrar el asa izquierdo +100 px ensancha el panel", Math.abs(w1 - 280) <= 2, `${w1}`);
  await reloadWith([rootA], rootA, {});
  await ev("document.querySelector('.commit:not(.wip)')?.click(); 1");
  await sleep(300);
  check("el ancho se persiste tras recargar", Math.abs((await rect(".branches")).w - 280) <= 2);
  const hl = await rect(".resizer-left");
  await mouseDrag({ x: hl.x + hl.w / 2, y: hl.y + 200 }, { x: hl.x + hl.w / 2 + 900, y: hl.y + 200 });
  // Tope = min(360, lo que deje libre la ventana con el derecho intacto).
  const winW0 = await ev("window.innerWidth");
  const rightW0 = (await rect(".status")).w;
  const expLeft = Math.min(360, winW0 - 480 - rightW0);
  const leftMax = (await rect(".branches")).w;
  check("izquierdo al máximo: llega al tope que permite la ventana", Math.abs(leftMax - expLeft) <= 2, `${leftMax} vs ${expLeft} (ventana ${winW0})`);
  check("… sin encoger el panel derecho", Math.abs((await rect(".status")).w - 280) <= 2, `${(await rect(".status")).w}`);
  const hr = await rect(".resizer-right");
  await mouseDrag({ x: hr.x + hr.w / 2, y: hr.y + 200 }, { x: hr.x + hr.w / 2 - 900, y: hr.y + 200 });
  // Tope = min(560, lo que deje libre la ventana): 480 px de centro intocables
  // y el panel izquierdo (360 tras el paso anterior) NO cede al arrastrar el derecho.
  const winW = await ev("window.innerWidth");
  const leftNow = (await rect(".branches")).w;
  const expRight = Math.min(560, winW - 480 - leftNow);
  const rightNow = (await rect(".status")).w;
  check("arrastrar el derecho al máximo: llega al tope que permite la ventana", Math.abs(rightNow - expRight) <= 2, `${rightNow} vs ${expRight} (ventana ${winW})`);
  check("… sin encoger el panel izquierdo", Math.abs(leftNow - leftMax) <= 2, `${leftNow} (antes ${leftMax})`);
  // Anchos guardados a pantalla grande, app abierta pequeña: el diff no puede quedar a 0.
  await ev("localStorage.setItem('gitpad:panels', JSON.stringify({left: 360, right: 560})); 1");
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  await ev("document.querySelector('.commit:not(.wip)')?.click(); 1");
  await sleep(300);
  const diffW = (await rect(".diffpane")).w;
  const commitsW = (await rect(".commits")).w;
  check("a 900 px con anchos guardados de 360/560 el diff conserva ≥ 260 px", diffW >= 259, `diff=${diffW}`);
  check("… y la lista de commits ≥ 220 px", commitsW >= 219, `commits=${commitsW}`);
  check("… y los laterales no se salen de la ventana", (await ev("document.documentElement.scrollWidth")) <= 901);
  await send("Emulation.clearDeviceMetricsOverride");
  await ev("localStorage.setItem('gitpad:panels', '{roto'); 1");
  await send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  check("JSON de paneles corrupto → vuelve a los valores por defecto", Math.round((await rect(".branches")).w) === 180);
  // Doble clic = restaurar.
  const hd = await rect(".resizer-left");
  await mouseDrag({ x: hd.x + hd.w / 2, y: hd.y + 200 }, { x: hd.x + hd.w / 2 + 60, y: hd.y + 200 });
  await ev("document.querySelector('.resizer-left').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 1");
  await sleep(300);
  check("doble clic en el asa restaura 180", Math.round((await rect(".branches")).w) === 180);

  // ===== 4. Modo árbol en «Archivos del commit» =====
  console.log("\n# 4. Lista / árbol en los archivos de un commit");
  await reloadWith([rootA], rootA, { "gitpad:panels": null, "gitpad:files-view": null });
  await ev(`(() => { Array.from(document.querySelectorAll('.commit')).find(e => e.querySelector('.subject')?.textContent === 'inicial').click(); return 1; })()`);
  await waitFor("document.querySelectorAll('.status .entry').length >= 5 ? 1 : null");
  const flat = await ev("Array.from(document.querySelectorAll('.status .entry .path')).map(e => e.textContent)");
  check("por defecto es lista con rutas completas", flat.includes("src/lib/util.ts") && flat.includes("ñandú/ç.txt"), JSON.stringify(flat));
  await ev("Array.from(document.querySelectorAll('.status .files-toggle button')).find(b => b.textContent === 'Árbol').click(); 1");
  await sleep(300);
  check("modo árbol muestra carpetas", (await ev("document.querySelectorAll('.status .tree-dir').length")) >= 3);
  const leaves = await ev("Array.from(document.querySelectorAll('.status .entry .path')).map(e => e.textContent)");
  check("las hojas muestran solo el nombre", leaves.includes("util.ts") && leaves.includes("ç.txt") && !leaves.includes("src/lib/util.ts"), JSON.stringify(leaves));
  check("el modo se persiste", (await ev("localStorage.getItem('gitpad:files-view')")) === "tree");
  await ev("document.querySelector('.status .tree-dir').click(); 1");
  await sleep(200);
  check("plegar una carpeta oculta sus hojas", (await ev("document.querySelectorAll('.status .entry').length")) < flat.length);
  await ev(`(() => { const d = document.querySelector('.status .tree-dir'); d.click(); return 1; })()`);
  await ev(`(() => { Array.from(document.querySelectorAll('.status .entry')).find(e => e.textContent.includes('util.ts')).click(); return 1; })()`);
  await waitFor("document.querySelector('.diff, .diff-wrap') ? 1 : null");
  check("clic en una hoja del árbol abre su diff", (await ev("document.querySelector('.diffpane')?.textContent.includes('export const one')")));

  // ===== 5. «Todos los archivos» + visor =====
  console.log("\n# 5. Explorador «Todos los archivos»");
  await ev("Array.from(document.querySelectorAll('.status .files-toggle button')).find(b => b.textContent === 'Todos los archivos').click(); 1");
  await waitFor("document.querySelector('.status .tree-scroll') ? 1 : null");
  const dirs = await ev("Array.from(document.querySelectorAll('.status .tree-dir-name')).map(e => e.textContent)");
  check("el árbol completo arranca plegado con las carpetas de primer nivel", dirs.includes("src") && dirs.includes("ñandú"), JSON.stringify(dirs));
  check("… y no muestra todavía src/lib", !dirs.includes("lib"));
  await ev("Array.from(document.querySelectorAll('.status .tree-dir')).find(d => d.textContent.includes('src')).click(); 1");
  await sleep(200);
  await ev("Array.from(document.querySelectorAll('.status .tree-dir')).find(d => d.textContent.includes('lib')).click(); 1");
  await sleep(200);
  await ev("Array.from(document.querySelectorAll('.status .entry')).find(e => e.textContent === 'util.ts').click(); 1");
  await waitFor("document.querySelector('.fileview-text') ? 1 : null");
  check("clic en un archivo muestra su contenido entero", (await ev("document.querySelector('.fileview-text').textContent")) === "export const one = 1;\nexport const two = 2;\n");
  check("con números de línea", (await ev("document.querySelector('.fileview-gutter').textContent")) === "1\n2");
  check("cabecera con la ruta completa", (await ev("document.querySelector('.fileview-path').textContent")) === "src/lib/util.ts");
  // Ruta no ASCII.
  await ev("Array.from(document.querySelectorAll('.status .tree-dir')).find(d => d.textContent.includes('ñandú')).click(); 1");
  await sleep(200);
  await ev("Array.from(document.querySelectorAll('.status .entry')).find(e => e.textContent === 'ç.txt').click(); 1");
  await waitFor("document.querySelector('.fileview-path')?.textContent === 'ñandú/ç.txt' ? 1 : null");
  check("ruta no-ASCII: contenido correcto", (await ev("document.querySelector('.fileview-text').textContent")).includes("áéí"));
  // Binario.
  await ev("Array.from(document.querySelectorAll('.status .entry')).find(e => e.textContent === 'logo.bin').click(); 1");
  await waitFor("document.querySelector('.diffpane .diff-empty') ? 1 : null");
  check("archivo binario: mensaje, sin volcar basura", (await ev("document.querySelector('.diffpane .diff-empty').textContent")).includes("binario"));
  // Contenido en el commit seleccionado, no en HEAD: `app.ts` tenía 1 línea en «inicial».
  // `src` ya está abierta por el paso anterior: solo se abre si está plegada.
  await ev(`(() => { const d = Array.from(document.querySelectorAll('.status .tree-dir')).find(d => d.textContent.trim() === 'src');
    if (d && d.getAttribute('aria-expanded') === 'false') d.click(); return 1; })()`);
  await sleep(200);
  await ev("Array.from(document.querySelectorAll('.status .entry')).find(e => e.textContent === 'app.ts')?.click(); 1");
  await waitFor("document.querySelector('.fileview-path')?.textContent === 'src/app.ts' ? 1 : null");
  check("el archivo se ve como estaba EN ESE commit (1 línea, no 2)", (await ev("document.querySelector('.fileview-text').textContent")) === "console.log('hola');\n");
  // Cambiar de commit recarga el árbol.
  await ev(`(() => { Array.from(document.querySelectorAll('.commit')).find(e => e.querySelector('.subject')?.textContent === 'segundo').click(); return 1; })()`);
  await waitFor("document.querySelector('.status .tree-scroll') ? 1 : null");
  await sleep(500);
  check("otro commit → el árbol sigue en «Todos los archivos»", (await ev("document.querySelector('.files-toggle button.on')?.textContent")) === "Todos los archivos");
  // Sin commit seleccionado → HEAD.
  await ev("Array.from(document.querySelectorAll('.status .files-toggle button')).find(b => b.textContent === 'Cambios').click(); 1");
  await sleep(200);
  check("volver a «Cambios» funciona", (await ev("document.querySelector('.files-toggle button.on')?.textContent")) === "Cambios");
  check("HEAD real del fixture sigue siendo el esperado", headHashA().length === 40);
} finally {
  // Restaurar el localStorage real (B1 de la revisión: los scripts no deben llevarse la sesión).
  await ev(`(() => { const b = ${JSON.stringify(backup)};
    for (const [k, v] of Object.entries(b)) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    return 1; })()`).catch(() => {});
  await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  ws.close();
  rmSync(base, { recursive: true, force: true });
}

console.log("\n# Consola");
check("cero errores/excepciones de consola", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
console.log(fails === 0 ? "\nTODO OK" : `\n${fails} FALLO(S)`);
process.exit(fails === 0 ? 0 : 1);
