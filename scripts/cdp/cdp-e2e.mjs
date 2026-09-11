// Verificación E2E de gitpad vía CDP crudo (WebView2 no es clicable con Playwright).
const CDP_HTTP = "http://localhost:9222/json";
const REPO = process.argv[2];
if (!REPO) {
  console.error("uso: node cdp-e2e.mjs <ruta-al-repo>");
  process.exit(1);
}

async function connect() {
  const list = await (await fetch(CDP_HTTP)).json();
  const target = list.find((t) => t.url?.startsWith("http://localhost:1420"));
  if (!target) throw new Error("no se encontró la página de gitpad en CDP");
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
  return { evalJs, close: () => ws.close() };
}

function esc(s) {
  return JSON.stringify(s);
}

const { evalJs, close } = await connect();

// 0. La página tiene contenido real (no está en blanco por un CSP roto).
const bodyLen = await evalJs("document.body.innerHTML.length");
console.log("body innerHTML length:", bodyLen);
if (bodyLen < 100) throw new Error("la página parece estar en blanco (¿CSP rota?)");

const csp = await evalJs(
  "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content ?? null",
);
console.log("CSP meta:", csp);

// 1. Abrir el repo de fixture vía invoke directo (sin diálogo de archivos).
const info = await evalJs(
  `window.__TAURI_INTERNALS__.invoke('open_repo', { path: ${esc(REPO)} })`,
);
console.log("open_repo:", JSON.stringify(info));

// 2. Ramas: comprobar contra `git branch -a` / `git worktree list` reales.
const branches = await evalJs(
  `window.__TAURI_INTERNALS__.invoke('get_branches', { path: ${esc(info.root)} })`,
);
console.log("branches:", JSON.stringify(branches, null, 2));

// 3. Checkout de una rama local sin bloquear.
const checkoutResult = await evalJs(
  `window.__TAURI_INTERNALS__.invoke('checkout_branch', { path: ${esc(info.root)}, name: 'fase-2' })
    .then(() => 'ok')
    .catch(e => 'error: ' + JSON.stringify(e))`,
);
console.log("checkout fase-2:", checkoutResult);

const infoAfter = await evalJs(
  `window.__TAURI_INTERNALS__.invoke('open_repo', { path: ${esc(REPO)} })`,
);
console.log("HEAD tras checkout:", infoAfter.head);

// volver a master para dejar el fixture limpio
await evalJs(
  `window.__TAURI_INTERNALS__.invoke('checkout_branch', { path: ${esc(info.root)}, name: 'master' })`,
);

// 4. Intentar checkout de la rama bloqueada por el worktree.
const lockedResult = await evalJs(
  `window.__TAURI_INTERNALS__.invoke('checkout_branch', { path: ${esc(info.root)}, name: 'wt-target' })
    .then(() => 'ok inesperado')
    .catch(e => 'error esperado: ' + e.message)`,
);
console.log("checkout de rama bloqueada por worktree:", lockedResult);

// 5. Búsqueda por mensaje.
const byMessage = await evalJs(
  `window.__TAURI_INTERNALS__.invoke('get_log', { path: ${esc(info.root)}, skip: 0, count: 200, filterMode: 'message', filterQuery: 'parseo' })`,
);
console.log(
  "búsqueda por mensaje 'parseo':",
  byMessage.map((c) => c.subject),
);

// 6. Búsqueda por contenido.
const byContent = await evalJs(
  `window.__TAURI_INTERNALS__.invoke('get_log', { path: ${esc(info.root)}, skip: 0, count: 200, filterMode: 'content', filterQuery: 'SECRETO_UNICO_XYZ' })`,
);
console.log(
  "búsqueda por contenido 'SECRETO_UNICO_XYZ':",
  byContent.map((c) => c.subject),
);

// 7. Búsqueda con un query que empieza por '-' (no debe leerse como opción).
const byDash = await evalJs(
  `window.__TAURI_INTERNALS__.invoke('get_log', { path: ${esc(info.root)}, skip: 0, count: 200, filterMode: 'message', filterQuery: '-arreglo' })
    .then(r => ({ ok: true, n: r.length }))
    .catch(e => ({ ok: false, e: e.message }))`,
);
console.log("búsqueda que empieza por '-':", JSON.stringify(byDash));

close();
console.log("--- fin ---");
