// Punto único de confirmaciones/avisos de la app. `window.__TAURI_INTERNALS__`
// está congelado (writable:false en todas sus props salvo `plugins`), así que
// un script E2E no puede interceptar el IPC directamente: por eso este módulo
// mira primero `window.__E2E_DIALOG__`, un hook que solo existe cuando lo
// instala un script de prueba (ver scripts/cdp/_dialog-mock.mjs). En la app
// real ese global no existe nunca y todo pasa por el plugin de diálogos.
import { confirm as confirmPlugin, message as messagePlugin } from "@tauri-apps/plugin-dialog";

declare global {
  interface Window {
    __E2E_DIALOG__?: (kind: "confirm" | "message", msg: string) => boolean;
  }
}

/** Diálogo Aceptar/Cancelar. `true` = Aceptar. */
export async function confirmAction(msg: string): Promise<boolean> {
  if (window.__E2E_DIALOG__) return window.__E2E_DIALOG__("confirm", msg);
  return confirmPlugin(msg, { kind: "warning" });
}

/** Aviso con un único botón Aceptar. */
export async function showMessage(msg: string): Promise<void> {
  if (window.__E2E_DIALOG__) {
    window.__E2E_DIALOG__("message", msg);
    return;
  }
  await messagePlugin(msg);
}
