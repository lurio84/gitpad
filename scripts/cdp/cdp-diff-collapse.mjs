// Verificación puntual de la tanda B (v0.9.0): la columna de diff se colapsa
// sin selección y se expande al seleccionar un commit. Usa el propio repo de
// gitpad como fixture (solo lectura: abrir + seleccionar/deseleccionar).
const CDP_HTTP = "http://localhost:9222/json";
const REPO = process.argv[2];
if (!REPO) {
  console.error("uso: node cdp-diff-collapse.mjs <ruta-al-repo>");
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
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(JSON.stringify(msg.params.args));
    }
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
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
  return { evalJs, consoleErrors, close: () => ws.close() };
}

function esc(s) {
  return JSON.stringify(s);
}

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLO"} — ${label}${extra ? `  [${extra}]` : ""}`);
  if (!cond) fails++;
};

const { evalJs, consoleErrors, close } = await connect();

// Seed localStorage con el repo (sin diálogo) y recarga: el camino real de
// App.tsx/tabModel.ts, no invoke crudo — así diffCollapsed sale del estado
// React real, no de un invoke aislado.
await evalJs(`localStorage.setItem('gitpad:tabs', JSON.stringify([${esc(REPO)}]))`);
await evalJs("location.reload()");

async function waitFor(expr, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evalJs(expr).catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout esperando: ${expr}`);
}

await waitFor("document.querySelector('.commit') ? 1 : null");
await new Promise((r) => setTimeout(r, 300));

// 1. Sin selección: colapsado.
const collapsedInitial = await evalJs("document.querySelector('.body').classList.contains('diff-collapsed')");
check("colapsado al abrir (sin selección)", collapsedInitial === true);
const diffWidthCollapsed = await evalJs("document.querySelector('.diffpane').getBoundingClientRect().width");
check("ancho del diffpane ~0 colapsado", diffWidthCollapsed < 5, String(diffWidthCollapsed));

// 2. Clic en el primer commit real (no //WIP): se expande.
await evalJs(`
  const rows = Array.from(document.querySelectorAll('.commit'));
  const row = rows.find((r) => !r.classList.contains('wip'));
  row.click();
`);
await new Promise((r) => setTimeout(r, 400));
const collapsedAfterSelect = await evalJs("document.querySelector('.body').classList.contains('diff-collapsed')");
check("expandido tras seleccionar un commit", collapsedAfterSelect === false);
const diffWidthExpanded = await evalJs("document.querySelector('.diffpane').getBoundingClientRect().width");
check("ancho del diffpane > 200 expandido", diffWidthExpanded > 200, String(diffWidthExpanded));

// 3. Reclic para deseleccionar: vuelve a colapsar.
await evalJs(`(() => {
  const rows = Array.from(document.querySelectorAll('.commit'));
  const row = rows.find((r) => !r.classList.contains('wip'));
  row.click();
})()`);
await new Promise((r) => setTimeout(r, 400));
const collapsedAfterDeselect = await evalJs("document.querySelector('.body').classList.contains('diff-collapsed')");
check("colapsado tras deseleccionar (reclic)", collapsedAfterDeselect === true);

// 4. Ctrl+clic sobre un commit distinto al ya seleccionado también deselecciona.
await evalJs(`(() => {
  const rows = Array.from(document.querySelectorAll('.commit'));
  rows.find((r) => !r.classList.contains('wip')).click();
})()`);
await new Promise((r) => setTimeout(r, 400));
await evalJs(`(() => {
  const rows = Array.from(document.querySelectorAll('.commit'));
  const row = rows.filter((r) => !r.classList.contains('wip'))[1];
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
})()`);
await new Promise((r) => setTimeout(r, 400));
const collapsedAfterCtrlClick = await evalJs("document.querySelector('.body').classList.contains('diff-collapsed')");
check("Ctrl+clic en otro commit deselecciona (colapsa)", collapsedAfterCtrlClick === true);

check("sin errores de consola", consoleErrors.length === 0, consoleErrors.join(" | "));

console.log(fails === 0 ? "\nTodo OK." : `\n${fails} fallo(s).`);
close();
process.exit(fails === 0 ? 0 : 1);
