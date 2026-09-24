// Mock de las confirmaciones/avisos de la app para las suites E2E.
//
// `window.__TAURI_INTERNALS__.invoke` está CONGELADO (writable:false,
// configurable:false en todas sus props salvo `plugins`) — comprobado en
// vivo, no se puede interceptar el IPC desde JS de página. Por eso
// `src/dialogs.ts` expone un seam explícito: si `window.__E2E_DIALOG__`
// existe, lo usa en vez de llamar al plugin real. Este archivo instala ese
// hook. En la app real ese global nunca existe.
//
// API expuesta en la página (igual que antes de existir el seam, para no
// tocar los sitios que ya leen/escriben `window.__ca`/`window.__msgs`):
//   window.__msgs   — mensajes mostrados, en orden
//   window.__ca     — cola de respuestas para confirm (true=Aceptar); vacía
//                      → auto-acepta
//   window.__pa     — valor que devuelve window.prompt (sin tocar, no pasa
//                      por el seam: el plugin no lo parchea)
export async function installDialogMock(ev) {
  await ev(`(() => {
    window.__msgs = [];
    window.__ca = [];
    window.__E2E_DIALOG__ = (kind, msg) => {
      window.__msgs.push(msg);
      if (kind === "message") return true;
      return window.__ca.length ? window.__ca.shift() : true;
    };
    // window.prompt: nativo, no lo toca tauri-plugin-dialog. Se deja el mismo
    // atajo que antes para no bloquear el script con un diálogo real (y,
    // peor, con CDP enganchado, colgarlo del todo — ver README).
    window.prompt = (m) => { window.__msgs.push(m); return window.__pa ?? ""; };
    return 1; })()`);
}
