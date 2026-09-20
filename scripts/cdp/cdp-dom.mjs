// Verificación E2E del flujo real de la UI (DOM), no solo invoke directo.
import { keepLocalStorage } from "./_ls.mjs";

const CDP_HTTP = "http://localhost:9222/json";
const REPO = process.argv[2];
if (!REPO) {
  console.error("uso: node cdp-dom.mjs <ruta-al-repo>");
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

const { evalJs, send, close } = await connect();
const restoreLS = await keepLocalStorage(evalJs, send);

// Sembrar localStorage con el repo como única pestaña y recargar: ejercita
// restoreRoots() -> reload() de verdad, no un invoke manual.
await evalJs(
  `localStorage.setItem('gitpad:tabs', JSON.stringify([${JSON.stringify(REPO)}]));
   localStorage.setItem('gitpad:active', ${JSON.stringify(REPO)});
   'ok'`,
);
await send("Page.reload", { ignoreCache: true });
await sleep(1500);

// Tras el reload, la conexión CDP sigue siendo la misma página (WebView2
// mantiene el mismo target); reintentar evalJs.
async function waitFor(expr, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr).catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout esperando: ${expr}`);
}

await waitFor("document.querySelector('.branches') ? true : null");
console.log("panel de ramas presente tras restaurar la pestaña: OK");

const branchNames = await evalJs(
  "Array.from(document.querySelectorAll('.branch-item .branch-name')).map(e => e.textContent)",
);
console.log("ramas en el DOM:", branchNames);

const lockedCount = await evalJs(
  "document.querySelectorAll('.branch-item.locked').length",
);
console.log("ramas bloqueadas (worktree) en el DOM:", lockedCount);

// Clic en 'fase-2' en el panel de ramas (evento real, como haría Bernardo).
const clicked = await evalJs(`
  (() => {
    const li = Array.from(document.querySelectorAll('.branch-item')).find(
      (el) => el.querySelector('.branch-name')?.textContent === 'fase-2'
    );
    if (!li) return 'no encontrado';
    li.click();
    return 'clic hecho';
  })()
`);
console.log("clic en rama 'fase-2':", clicked);
await sleep(1200);

const headAfterClick = await waitFor(
  "document.querySelector('.branch')?.textContent",
);
console.log("rama activa en la topbar tras el clic:", headAfterClick);

// Volver a master vía DOM para dejar limpio.
await evalJs(`
  (() => {
    const li = Array.from(document.querySelectorAll('.branch-item')).find(
      (el) => el.querySelector('.branch-name')?.textContent === 'master'
    );
    li?.click();
  })()
`);
await sleep(1000);

// Búsqueda por el input real del DOM (setter nativo + evento 'input', como
// hace React con inputs controlados).
await evalJs(`
  (() => {
    const input = document.querySelector('.search input');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    setter.call(input, 'parseo');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.search').requestSubmit();
  })()
`);
await sleep(1000);

const filterInfo = await evalJs(
  "document.querySelector('.filter-info')?.textContent ?? null",
);
console.log("línea de resultados de búsqueda:", filterInfo);

const commitSubjects = await evalJs(
  "Array.from(document.querySelectorAll('.commit .subject')).map(e => e.textContent)",
);
console.log("commits mostrados tras buscar 'parseo':", commitSubjects);

// Limpiar el filtro con el botón "limpiar".
await evalJs(`document.querySelector('.filter-info .link')?.click()`);
await sleep(800);
const afterClear = await evalJs(
  "document.querySelector('.filter-info') ? 'sigue visible' : 'oculto'",
);
console.log("línea de filtro tras 'limpiar':", afterClear);

await restoreLS();
close();
console.log("--- fin ---");
