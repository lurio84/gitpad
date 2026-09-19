const CDP_HTTP = "http://localhost:9222/json";
const REPO = process.argv[2];

async function connect() {
  const list = await (await fetch(CDP_HTTP)).json();
  const target = list.find((t) => t.url?.startsWith("http://localhost:1420") || t.url?.includes("tauri.localhost"));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
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
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }); // sin animaciones: mediciones y capturas deterministas
  async function evalJs(expression) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  return { evalJs, send, close: () => ws.close() };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const { evalJs, send, close } = await connect();

await evalJs(
  `localStorage.setItem('gitpad:tabs', JSON.stringify([${JSON.stringify(REPO)}]));
   localStorage.setItem('gitpad:active', ${JSON.stringify(REPO)});
   'ok'`,
);
await send("Page.reload", { ignoreCache: true });
await sleep(2000);

async function waitFor(expr, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr).catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout esperando: ${expr}`);
}
await waitFor("document.querySelectorAll('.commit').length > 0 ? true : null");

const report = await evalJs(`
  (() => {
    const rows = Array.from(document.querySelectorAll('.commit'));
    const clipped = [];
    for (const el of rows) {
      if (el.scrollHeight > el.clientHeight + 1) {
        const code = el.querySelector('code')?.textContent ?? '?';
        const refs = Array.from(el.querySelectorAll('.ref')).map(r => r.textContent);
        clipped.push({ hash: code, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, refs, authors: el.querySelector('.commit-meta span')?.textContent });
      }
    }
    return { total: rows.length, clippedCount: clipped.length, clipped: clipped.slice(0, 15) };
  })()
`);
console.log(JSON.stringify(report, null, 2));

await send("Emulation.setEmulatedMedia", { features: [] }); // deja la app como estaba (con animaciones)

close();
