// E2E de "Cargar más commits" y del filtro por rama, vía el DOM real.
//   node cdp-log-view.mjs <repo> <rama>
// El repo necesita más de 2 páginas de commits (LOG_PAGE = 200) en la rama
// activa y una segunda rama con historial propio distinto.
import { execFileSync } from "node:child_process";

const [REPO, BRANCH] = process.argv.slice(2);
if (!REPO || !BRANCH) {
  console.error("uso: node cdp-log-view.mjs <repo> <rama-a-filtrar>");
  process.exit(1);
}
const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
const total = Number(git("rev-list", "--count", "--all"));
const inBranch = Number(git("rev-list", "--count", BRANCH));

const list = await (await fetch("http://localhost:9222/json")).json();
const target = list.find(
  (t) => t.url?.startsWith("http://localhost:1420") || t.url?.includes("tauri.localhost"),
);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
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
async function waitFor(expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr).catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timeout esperando: ${expr}`);
}
let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLO"} — ${label}${extra ? ` (${extra})` : ""}`);
  if (!cond) fails++;
};
// Filas reales de commit: sin el nodo //WIP.
const rows = () => evalJs("document.querySelectorAll('.commit:not(.wip)').length");
const moreBtn = () =>
  evalJs("Array.from(document.querySelectorAll('.more button')).some(b => /Cargar más/.test(b.textContent))");

await send("Runtime.enable");
await send("Page.enable");
await evalJs(`localStorage.setItem('gitpad:tabs', JSON.stringify([${JSON.stringify(REPO)}]));
  localStorage.setItem('gitpad:active', ${JSON.stringify(REPO)}); 'ok'`);
await send("Page.reload", { ignoreCache: true });
await waitFor("document.querySelectorAll('.commit').length > 0 ? true : null");
await sleep(500);

// --- F1: cargar más ---
check("1ª página = 200 filas", (await rows()) === 200, `filas=${await rows()}`);
check("hay botón 'Cargar más commits'", await moreBtn());

// Selecciono un commit y compruebo que cargar más no lo deselecciona.
await evalJs("document.querySelectorAll('.commit:not(.wip)')[5].click(); 'ok'");
await sleep(500);
const selBefore = await evalJs("document.querySelector('.commit.sel .commit-meta code')?.textContent");
await evalJs("Array.from(document.querySelectorAll('.more button')).find(b => /Cargar más/.test(b.textContent)).click(); 'ok'");
await waitFor("document.querySelectorAll('.commit:not(.wip)').length === 400 ? true : null");
check("tras cargar más hay 400 filas", (await rows()) === 400, `filas=${await rows()}`);
const selAfter = await evalJs("document.querySelector('.commit.sel .commit-meta code')?.textContent");
check("cargar más conserva la selección", !!selBefore && selBefore === selAfter, `${selBefore} -> ${selAfter}`);

// Un refresco al volver a la ventana (alt-tab) no debe encoger la lista.
await evalJs("window.dispatchEvent(new Event('focus')); 'ok'");
await sleep(1500);
check("el refresco por foco mantiene 400 filas", (await rows()) === 400, `filas=${await rows()}`);

await evalJs("Array.from(document.querySelectorAll('.more button')).find(b => /Cargar más/.test(b.textContent)).click(); 'ok'");
const expected3 = Math.min(600, total);
await waitFor(`document.querySelectorAll('.commit:not(.wip)').length === ${expected3} ? true : null`);
check(`la 3ª página trae ${expected3} filas (${total} en total)`, (await rows()) === expected3);
// El botón solo desaparece si ya no queda historia por cargar.
check(
  total <= 600 ? "sin más commits, el botón desaparece" : "con más historia, el botón sigue",
  (await moreBtn()) === total > 600,
);

// --- F3: filtrar por rama ---
const clickFilter = (name) =>
  evalJs(`(() => {
    const li = Array.from(document.querySelectorAll('.branch-item')).find(e => e.querySelector('.branch-name')?.textContent === ${JSON.stringify(name)});
    const b = li?.querySelector('.branch-filter'); if (!b) return false; b.click(); return true; })()`);
check(`botón de filtro de '${BRANCH}' existe`, await clickFilter(BRANCH));
await waitFor("document.querySelector('.filter-info strong') ? true : null");
await sleep(500);
const chip = await evalJs("document.querySelector('.filter-info strong')?.textContent");
check("aparece el chip 'Viendo solo <rama>'", chip === BRANCH, `chip=${chip}`);
const expectedBranch = Math.min(200, inBranch);
check(`solo ${expectedBranch} commits de esa rama`, (await rows()) === expectedBranch, `filas=${await rows()} esperadas=${expectedBranch}`);
const branchNow = await evalJs("document.querySelector('.branch-item.current .branch-name')?.textContent");
check("filtrar no hace checkout", branchNow !== BRANCH, `rama actual=${branchNow}`);

await evalJs("Array.from(document.querySelectorAll('.filter-info .link')).find(b => /ver todas/.test(b.textContent)).click(); 'ok'");
await waitFor("!document.querySelector('.filter-info strong') ? true : null");
await sleep(600);
check("'ver todas' vuelve a la primera página del log completo", (await rows()) === 200, `filas=${await rows()}`);

console.log(fails === 0 ? "\nTODO OK" : `\n${fails} FALLO(S)`);
ws.close();
process.exit(fails ? 1 : 0);
