import { execFileSync } from "node:child_process";

const CDP_HTTP = "http://localhost:9222/json";
const REPO = process.argv[2];
if (!REPO) {
  console.error("uso: node cdp-graph.mjs <ruta-al-repo>");
  process.exit(1);
}

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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
  return { evalJs, send, close: () => ws.close() };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const { evalJs, send, close } = await connect();

// Sembrar la pestaña y recargar (mismo truco que en sesiones anteriores).
await evalJs(
  `localStorage.setItem('gitpad:tabs', JSON.stringify([${JSON.stringify(REPO)}]));
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

await waitFor("document.querySelector('.graph') ? true : null");

// Orden de filas tal cual las pinta la app (mismo orden = mismas filas). El
// nodo //WIP (si hay cambios sin comprometer) es una fila más sin `<code>` —
// se guarda como `null` para no perder el índice del resto.
const domOrder = await evalJs(
  `Array.from(document.querySelectorAll('.commit')).map(
    (el) => el.querySelector('.commit-meta code')?.textContent ?? null,
  )`,
);
console.log("orden de filas en el DOM (null = //WIP):", domOrder);

// ROW_H sale de --row-h (publicada por App.tsx desde Graph.tsx): una sola
// fuente, no se duplica aquí.
const ROW_H = await evalJs(
  "parseFloat(getComputedStyle(document.querySelector('.app')).getPropertyValue('--row-h'))",
);

// Geometría del SVG: círculos (fila->carril) y líneas/paths (conexiones).
const svgInfo = await evalJs(`
  (() => {
    const svg = document.querySelector('.graph');
    const circles = Array.from(svg.querySelectorAll('circle')).map(c => ({
      cx: +c.getAttribute('cx'), cy: +c.getAttribute('cy'),
    }));
    const lines = Array.from(svg.querySelectorAll('line')).map(l => ({
      x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'),
      x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2'),
      dashed: l.getAttribute('stroke-dasharray') !== null,
    }));
    const paths = Array.from(svg.querySelectorAll('path')).map(p => p.getAttribute('d'));
    return { circles, lines, paths, width: +svg.getAttribute('width'), height: +svg.getAttribute('height') };
  })()
`);
console.log("SVG:", JSON.stringify(svgInfo, null, 2));

close();

// --- Verificación estructural contra git real ---
const raw = execFileSync("git", ["-C", REPO, "log", "--all", "--date-order", "--pretty=%H %P"])
  .toString()
  .trim()
  .split("\n")
  .map((l) => {
    const [hash, ...parents] = l.split(" ").filter(Boolean);
    return [hash, parents];
  });
const shortOf = (h) => h.slice(0, 7);
const rowOfShort = new Map(
  domOrder.map((s, i) => [s, i]).filter(([s]) => s !== null),
);

const LANE_W = 16;
const rowFromCy = (cy) => Math.round((cy - ROW_H / 2) / ROW_H);
const laneFromCx = (cx) => Math.round((cx - LANE_W / 2) / LANE_W);

// mapa fila -> carril, a partir de los círculos (uno por commit, en orden del DOM)
const laneOfRow = new Map();
svgInfo.circles.forEach((c) => {
  const row = rowFromCy(c.cy);
  laneOfRow.set(row, laneFromCx(c.cx));
});
console.log("carril por fila:", [...laneOfRow.entries()]);

let ok = 0, fail = 0;
for (const [hash, parents] of raw) {
  const short = shortOf(hash);
  const fromRow = rowOfShort.get(short);
  if (fromRow === undefined) continue; // no debería pasar, todos están en el DOM
  const fromLane = laneOfRow.get(fromRow);
  for (const p of parents) {
    const pShort = shortOf(p);
    const toRow = rowOfShort.get(pShort);
    if (toRow === undefined) {
      console.log(`(fuera de ventana, no verificable aquí) ${short} -> ${pShort}`);
      continue;
    }
    const toLane = laneOfRow.get(toRow);
    // Buscar una line o path cuyo punto de origen sea (fromLane,fromRow) y destino (toLane,toRow)
    const y1 = fromRow * ROW_H + ROW_H / 2;
    const y2 = toRow * ROW_H + ROW_H / 2;
    const x1 = fromLane * LANE_W + LANE_W / 2;
    const x2 = toLane * LANE_W + LANE_W / 2;
    const inLines = svgInfo.lines.some(
      (l) => Math.abs(l.x1 - x1) < 0.5 && Math.abs(l.y1 - y1) < 0.5 &&
             Math.abs(l.x2 - x2) < 0.5 && Math.abs(l.y2 - y2) < 0.5,
    );
    const inPaths = svgInfo.paths.some((d) => d.startsWith(`M ${x1} ${y1} C`) && d.endsWith(`${x2} ${y2}`));
    if (inLines || inPaths) {
      console.log(`OK  ${short}(fila ${fromRow},carril ${fromLane}) -> ${pShort}(fila ${toRow},carril ${toLane})`);
      ok++;
    } else {
      console.log(`FALTA edge para ${short} -> ${pShort} (esperado (${x1},${y1})->(${x2},${y2}))`);
      fail++;
    }
  }
}
console.log(`\nresultado: ${ok} conexiones verificadas, ${fail} faltantes`);
