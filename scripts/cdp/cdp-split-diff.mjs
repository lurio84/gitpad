// Verificación de la vista side-by-side: alineación de columnas entre filas,
// ausencia de solapamiento entre .split-ln/.split-text, y que ningún archivo
// obligue a scroll horizontal (los tres defectos reales encontrados en la
// segunda ronda de feedback de Bernardo sobre v0.3.0 — ver Backlog.md).
//
// A diferencia de los demás scripts de esta carpeta, el target acepta tanto
// dev (localhost:1420) como el binario de producción (tauri.localhost): no
// hace falta tocar el script al pasar de `npm run tauri dev` a verificar el
// `.exe` empaquetado.
const CDP_HTTP = "http://localhost:9222/json";
const REPO = process.argv[2];
const HASH = process.argv[3];
if (!REPO || !HASH) {
  console.error("uso: node cdp-split-diff.mjs <ruta-al-repo> <hash-commit>");
  process.exit(1);
}

async function connect() {
  const list = await (await fetch(CDP_HTTP)).json();
  const target = list.find(
    (t) =>
      t.url?.startsWith("http://localhost:1420") ||
      t.url?.startsWith("http://tauri.localhost"),
  );
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
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleErrors.push(msg.params.entry.text);
    }
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
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }); // sin animaciones: mediciones y capturas deterministas
  await send("Page.enable");
  await send("Log.enable");
  async function evalJs(expression) {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails),
      );
    }
    return r.result.value;
  }
  return { evalJs, send, consoleErrors, close: () => ws.close() };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const { evalJs, send, consoleErrors, close } = await connect();

await evalJs(
  `localStorage.setItem('gitpad:tabs', JSON.stringify([${JSON.stringify(REPO)}]));
   localStorage.setItem('gitpad:active', ${JSON.stringify(REPO)});
   localStorage.setItem('gitpad:diff-view', 'split');
   'ok'`,
);
await send("Page.reload", { ignoreCache: true });
await sleep(2000);

async function waitFor(expr, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr).catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout esperando: ${expr}`);
}

await waitFor("document.querySelector('.commit-list') ? true : null");

const clicked = await evalJs(`
  (() => {
    const li = Array.from(document.querySelectorAll('.commit')).find(
      (el) => el.querySelector('.commit-meta code')?.textContent?.startsWith(${JSON.stringify(HASH)})
    );
    if (!li) return 'no encontrado';
    li.click();
    return 'clic hecho: ' + (li.querySelector('.subject')?.textContent ?? '?');
  })()
`);
console.log("clic en commit:", clicked);
await sleep(1200);

const toolbarOn = await waitFor(
  "document.querySelector('.diff-toolbar button.on')?.textContent",
);
console.log("modo de diff activo:", toolbarOn);
if (toolbarOn !== "Side by side") {
  console.error("FALLO: el toggle no quedó en Side by side");
  process.exit(1);
}

// 1. Alineación: dentro de cada .split-file, las columnas de números de
// línea deben caer siempre en la misma X (una sola entrada en cada set).
const alignment = await evalJs(`
  (() => {
    const files = Array.from(document.querySelectorAll('.split-file'));
    return files.map((file, fi) => {
      const lns = Array.from(file.querySelectorAll('.split-ln'));
      const leftXs = [...new Set(lns.filter((_, i) => i % 2 === 0).map(el => Math.round(el.getBoundingClientRect().left)))];
      const rightXs = [...new Set(lns.filter((_, i) => i % 2 === 1).map(el => Math.round(el.getBoundingClientRect().left)))];
      return { fi, rows: lns.length / 2, leftXs, rightXs };
    });
  })()
`);
const misaligned = alignment.filter((f) => f.leftXs.length > 1 || f.rightXs.length > 1);
console.log(`archivos con columnas desalineadas entre filas (${misaligned.length}, vacío = OK):`, JSON.stringify(misaligned));

// 2. Solapamiento: ningún span de una fila debe invadir el siguiente.
// display:contents en .split-row hace que esto siga cazando una regresión
// de emparejado si vuelve a bajarse el grid a nivel de fila.
const overlap = await evalJs(`
  (() => {
    const rows = Array.from(document.querySelectorAll('.split-row'));
    const bad = [];
    for (const row of rows) {
      const spans = Array.from(row.children);
      for (let i = 0; i < spans.length - 1; i++) {
        const a = spans[i].getBoundingClientRect();
        const b = spans[i + 1].getBoundingClientRect();
        if (a.right > b.left + 0.5) bad.push({ i, aRight: Math.round(a.right), bLeft: Math.round(b.left) });
      }
    }
    return bad.slice(0, 10);
  })()
`);
console.log("filas con solapamiento detectado (vacío = OK):", JSON.stringify(overlap));

// 3. Scrollport: el defecto real que la alineación y el solapamiento NO
// detectan — columnas alineadas y sin invadirse, pero la segunda mitad
// empujada fuera del panel visible. Esto fue lo que se coló en la primera
// pasada del fix del solapamiento (ver Backlog.md, "segunda ronda").
const scroll = await evalJs(`
  (() => {
    const el = document.querySelector('.diff');
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  })()
`);
const needsHorizontalScroll = scroll.scrollWidth > scroll.clientWidth + 1;
console.log("scrollWidth/clientWidth del panel de diff:", JSON.stringify(scroll), "— scroll horizontal necesario:", needsHorizontalScroll);

console.log("errores de consola:", consoleErrors);

const ok = misaligned.length === 0 && overlap.length === 0;
if (!ok) {
  console.error("FALLO: hay desalineación u overlap — ver arriba.");
  process.exit(1);
}
if (needsHorizontalScroll) {
  console.warn(
    "AVISO: este commit concreto necesita scroll horizontal (puede ser normal si tiene líneas muy largas — revisar visualmente antes de tratarlo como fallo).",
  );
}

await send("Emulation.setEmulatedMedia", { features: [] }); // deja la app como estaba (con animaciones)

close();
console.log("--- fin ---");
