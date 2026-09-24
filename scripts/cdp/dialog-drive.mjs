// Driver mínimo para provocar diálogos NATIVOS reales (sin mock) y que
// native-dialog-click.ps1 los cierre con un clic de ratón real. Complementa
// a las suites cdp-v0*.mjs (que SÍ mockean vía el seam __E2E_DIALOG__/
// __E2E_CHOICE__): esto es la única comprobación que ejercita de verdad el
// IPC hacia Rust y el diálogo real de Windows. Ver README §Confirmaciones.
//   node dialog-drive.mjs <root-repo> seed        — siembra el tab
//   node dialog-drive.mjs x discard                — clic en 🗑 del primer archivo
//   node dialog-drive.mjs x about                  — clic en ⓘ
//   node dialog-drive.mjs x deletetag <nombre>      — borrar tag desde el panel de Ramas
const PORT = process.env.CDP_PORT ?? "9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [root, cmd, arg] = process.argv.slice(2);

const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
const target = list.find(
  (t) => t.type === "page" && /^https?:\/\/(localhost:1420|tauri\.localhost)/.test(t.url ?? ""),
);
if (!target) {
  console.error("No hay página de gitpad con el puerto CDP abierto (ver README).");
  process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    console.error("EXCEPTION:", msg.params.exceptionDetails.exception?.description ?? JSON.stringify(msg.params));
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function ev(expression, awaitPromise = true) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval");
  return r.result.value;
}
await send("Runtime.enable");

if (cmd === "seed") {
  await ev(`(() => {
    localStorage.setItem('gitpad:tabs', ${JSON.stringify(JSON.stringify([root]))});
    localStorage.setItem('gitpad:active', ${JSON.stringify(root)});
    return 1; })()`);
  await send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  const ok = await ev("document.querySelector('.commit') ? 1 : null");
  console.log("seed:", ok ? "OK" : "FALLO — no cargó .commit");
} else if (cmd === "discard") {
  const r = await ev(
    `(() => {
      const b = document.querySelector('button[title="Descartar cambios"], button[title="Borrar archivo sin seguimiento"]');
      if (!b) return 'NO_BUTTON';
      b.click();
      return 'CLICKED';
    })()`,
    false,
  );
  console.log("discard click:", r);
} else if (cmd === "about") {
  const r = await ev(
    `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'ⓘ');
      if (!b) return 'NO_BUTTON';
      b.click();
      return 'CLICKED';
    })()`,
    false,
  );
  console.log("about click:", r);
} else if (cmd === "deletetag") {
  await ev(`(() => {
    const label = Array.from(document.querySelectorAll('.branch-group-label')).find((e) => e.textContent === 'Etiquetas');
    const row = label && Array.from(label.parentElement.querySelectorAll('.branch-item')).find((r) => r.querySelector('.branch-name')?.textContent === ${JSON.stringify(arg)});
    if (!row) return 'NO_ROW';
    row.querySelector('.branch-menu').click();
    return 'OK';
  })()`);
  await sleep(300);
  const r = await ev(
    `(() => {
      const b = Array.from(document.querySelectorAll('.ctx-menu button')).find((x) => x.textContent.trim() === 'Borrar…');
      if (!b) return 'NO_BUTTON: ' + Array.from(document.querySelectorAll('.ctx-menu button')).map(x=>x.textContent.trim()).join('|');
      b.click();
      return 'CLICKED';
    })()`,
    false,
  );
  console.log("deletetag click:", r);
} else {
  console.error("cmd desconocido: seed | discard | about | deletetag <nombre>");
  process.exit(2);
}
process.exit(0);
