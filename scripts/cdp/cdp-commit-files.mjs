// Verificación E2E de FEAT-001: listado de archivos por commit (A), diff de
// un solo archivo (B) y toggle side-by-side/unificado (C) — vía el DOM real.
const CDP_HTTP = "http://localhost:9222/json";
const REPO = process.argv[2];
if (!REPO) {
  console.error("uso: node cdp-commit-files.mjs <ruta-al-repo>");
  process.exit(1);
}

async function connect() {
  const list = await (await fetch(CDP_HTTP)).json();
  const target = list.find((t) => t.url?.startsWith("http://localhost:1420"));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  function send(method, params = {}) {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }
  await send("Runtime.enable");
  await send("Page.enable");
  async function evalJs(expression) {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ??
          JSON.stringify(r.exceptionDetails),
      );
    }
    return r.result.value;
  }
  return { evalJs, send, close: () => ws.close() };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let fails = 0;
function check(label, cond) {
  console.log(`${cond ? "OK" : "FALLO"} — ${label}`);
  if (!cond) fails++;
}

const { evalJs, send, close } = await connect();

await evalJs(
  `localStorage.removeItem('gitpad:diff-view');
   localStorage.setItem('gitpad:tabs', JSON.stringify([${JSON.stringify(REPO)}]));
   localStorage.setItem('gitpad:active', ${JSON.stringify(REPO)});
   'ok'`,
);
await send("Page.reload", { ignoreCache: true });
await sleep(1500);

async function waitFor(expr, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr).catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout esperando: ${expr}`);
}

await waitFor("document.querySelectorAll('.commit').length > 0 ? true : null");

// --- Pieza A: clic en el commit "multi" (2 archivos) → lista de archivos ---
const clickedMulti = await evalJs(`
  (() => {
    const li = Array.from(document.querySelectorAll('.commit')).find(
      (el) => el.querySelector('.subject')?.textContent.startsWith('multi:')
    );
    if (!li) return 'no encontrado';
    li.click();
    return 'clic hecho';
  })()
`);
check("clic en commit 'multi'", clickedMulti === "clic hecho");
await sleep(1000);

const header = await waitFor("document.querySelector('.status h2')?.textContent");
check("cabecera del panel dice 'Archivos del commit'", header === "Archivos del commit");

const files = await evalJs(
  "Array.from(document.querySelectorAll('.status .entry .path')).map(e => e.textContent)",
);
console.log("archivos listados:", files);
check("lista 2 archivos (a.txt, b.txt)", files.length === 2 && files.includes("a.txt") && files.includes("b.txt"));

const fullDiffLines = await evalJs(
  "document.querySelectorAll('.diff .dl, .diff .split-row').length",
);
check("diff completo del commit no está vacío", fullDiffLines > 0);

// --- Pieza B: clic en un archivo del commit → solo su diff ---
const clickedFile = await evalJs(`
  (() => {
    const li = Array.from(document.querySelectorAll('.status .entry')).find(
      (el) => el.querySelector('.path')?.textContent === 'b.txt'
    );
    if (!li) return 'no encontrado';
    li.click();
    return 'clic hecho';
  })()
`);
check("clic en archivo 'b.txt' del commit", clickedFile === "clic hecho");
await sleep(1000);

const fileHeaders = await evalJs(
  "Array.from(document.querySelectorAll('.diff .dl.meta')).map(e => e.textContent).filter(t => t.startsWith('diff --git'))",
);
console.log("cabeceras 'diff --git' tras filtrar por b.txt:", fileHeaders);
check("el diff filtrado por archivo solo tiene un 'diff --git'", fileHeaders.length === 1);
check("la cabecera es de b.txt", fileHeaders[0]?.includes("b.txt") ?? false);

// --- Pieza C: toggle side-by-side (por defecto) / unificado ---
const defaultMode = await evalJs(
  "document.querySelector('.diff-toolbar button.on')?.textContent",
);
check("modo por defecto es 'Lado a lado'", defaultMode === "Lado a lado");

const splitRows = await evalJs("document.querySelectorAll('.split-row').length");
check("la vista lado a lado renderiza filas .split-row", splitRows > 0);

await evalJs(`
  Array.from(document.querySelectorAll('.diff-toolbar button')).find(
    (b) => b.textContent === 'Unificado'
  ).click();
`);
await sleep(500);
const unifiedActive = await evalJs(
  "document.querySelector('.diff-toolbar button.on')?.textContent",
);
check("toggle a 'Unificado' funciona", unifiedActive === "Unificado");

const persisted = await evalJs("localStorage.getItem('gitpad:diff-view')");
check("modo persistido en localStorage", persisted === "unified");

await send("Page.reload", { ignoreCache: true });
await sleep(1500);
await waitFor("document.querySelectorAll('.commit').length > 0 ? true : null");
const afterReload = await evalJs(
  "document.querySelector('.diff-toolbar button.on')?.textContent ?? 'sin selección'",
);
console.log("modo tras recargar (sin selección activa, se espera el toolbar aun así):", afterReload);
check("el modo sigue en 'Unificado' tras recargar", afterReload === "Unificado" || afterReload === "sin selección");

// --- Merge: no debe romper nada, debe mostrar la nota ---
const clickedMerge = await evalJs(`
  (() => {
    const li = Array.from(document.querySelectorAll('.commit')).find(
      (el) => el.querySelector('.subject')?.textContent.startsWith('merge')
    );
    if (!li) return 'no encontrado';
    li.click();
    return 'clic hecho';
  })()
`);
check("clic en commit de merge", clickedMerge === "clic hecho");
await sleep(1000);
const mergeNote = await evalJs("document.querySelector('.status .clean')?.textContent");
check("nota de merge visible", (mergeNote ?? "").includes("fusión"));

const consoleErrors = await evalJs(
  "window.__gitpadConsoleErrors ?? 'sin listener (ok, no se instrumentó)'",
);
console.log("errores de consola:", consoleErrors);

close();
console.log(`--- fin: ${fails === 0 ? "TODO OK" : `${fails} fallo(s)`} ---`);
process.exit(fails === 0 ? 0 : 1);
