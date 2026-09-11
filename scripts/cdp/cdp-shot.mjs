const CDP_HTTP = "http://localhost:9222/json";
const OUT = process.argv[2];

const list = await (await fetch(CDP_HTTP)).json();
const target = list.find((t) => t.url?.startsWith("http://localhost:1420"));
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
await send("Log.enable");
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 500));
const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
console.log("screenshot guardado en", OUT);
console.log("errores de consola capturados (post-conexión):", consoleErrors);
ws.close();
