// Capturas de pantalla del recorrido real de revisión de un commit, para
// comparar antes/después de un cambio visual.
//   node cdp-shots.mjs <repo> <dir-de-salida> <prefijo> [conflict]
// Sin "conflict": árbol de trabajo → commit → archivo (side-by-side) →
// unificado → commit de merge. Con "conflict": solo el estado con banner
// (el repo debe tener un rebase/merge parado por conflicto).
import fs from "node:fs";
import path from "node:path";

const [REPO, OUT, PREFIX, MODE] = process.argv.slice(2);
if (!REPO || !OUT || !PREFIX) {
  console.error("uso: node cdp-shots.mjs <repo> <dir-salida> <prefijo> [conflict]");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://localhost:9222/json")).json();
const target = list.find(
  (t) => t.url?.startsWith("http://localhost:1420") || t.url?.includes("tauri.localhost"),
);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error")
    consoleErrors.push(msg.params.entry.text);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval");
  return r.result.value;
}
async function waitFor(expr, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr).catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout esperando: ${expr}`);
}
async function shot(name) {
  await sleep(400);
  const r = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `${PREFIX}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("captura:", file);
}
const clickCommit = (text) =>
  evalJs(`(() => {
    const li = Array.from(document.querySelectorAll('.commit')).find(e => e.textContent.includes(${JSON.stringify(text)}));
    if (!li) return false; li.click(); return true; })()`);
const clickEntry = (text) =>
  evalJs(`(() => {
    const li = Array.from(document.querySelectorAll('.status .entry')).find(e => e.textContent.includes(${JSON.stringify(text)}));
    if (!li) return false; li.click(); return true; })()`);

await send("Log.enable");
await send("Runtime.enable");
await send("Page.enable");
// Mismo tamaño en cada tanda: si no, antes/después no son comparables.
await send("Emulation.setDeviceMetricsOverride", {
  width: 1100, height: 720, deviceScaleFactor: 1, mobile: false,
});
await evalJs(`localStorage.setItem('gitpad:tabs', JSON.stringify([${JSON.stringify(REPO)}]));
  localStorage.setItem('gitpad:active', ${JSON.stringify(REPO)});
  localStorage.removeItem('gitpad:diff-view'); 'ok'`);
await send("Page.reload", { ignoreCache: true });
await waitFor("document.querySelectorAll('.commit').length > 0 ? true : null");
await sleep(600);

if (MODE === "conflict") {
  await shot("5-conflicto");
} else {
  await shot("1-arbol-de-trabajo");
  if (!(await clickCommit("Añade división"))) throw new Error("commit 'Añade división' no encontrado");
  await sleep(700);
  await shot("2-commit-y-archivos");
  if (!(await clickEntry("math.ts"))) throw new Error("archivo math.ts no encontrado");
  await sleep(700);
  await shot("3-diff-side-by-side");
  await evalJs(`Array.from(document.querySelectorAll('.diff-toolbar button')).find(b => /unified/i.test(b.textContent))?.click(); 'ok'`);
  await shot("4-diff-unificado");
  await evalJs(`localStorage.removeItem('gitpad:diff-view'); 'ok'`);
  if (!(await clickCommit("Fusiona feature"))) throw new Error("merge no encontrado");
  await sleep(700);
  await shot("6-commit-de-merge");
}
console.log("errores de consola:", consoleErrors);
ws.close();
