// Respaldo y restauración del `localStorage` de la app bajo prueba.
//
// Los scripts siembran `gitpad:tabs`/`gitpad:active` para abrir su repo de
// fixture. Contra el binario de producción (origen `tauri.localhost`) eso pisa
// las pestañas REALES de quien lo usa; contra `tauri dev` (`localhost:1420`) no,
// porque `localStorage` es por origen. Uso:
//
//   const restoreLS = await keepLocalStorage(evalJs, send); // antes de sembrar
//   ...
//   await restoreLS();                                      // antes de cerrar el ws
//
// Además engancha `process.exit` y los errores no capturados, para que un
// script que falla a medias tampoco se lleve la sesión. Tras restaurar recarga
// la página: si no, el estado en memoria de React conservaría la pestaña de
// prueba y podría volver a escribirla.

const PREFIX = "gitpad:";

export async function keepLocalStorage(evalJs, send) {
  const backup = await evalJs(
    `(() => { const o = {}; for (const k of Object.keys(localStorage)) if (k.startsWith(${JSON.stringify(PREFIX)})) o[k] = localStorage.getItem(k); return o; })()`,
  );

  let restored = false;
  async function restore() {
    if (restored) return;
    restored = true;
    // `null`-safe: se borran TODAS las claves gitpad:* actuales (también las que
    // el script creó y no existían) y se devuelven las del respaldo.
    await evalJs(
      `(() => { const b = ${JSON.stringify(backup)};
        for (const k of Object.keys(localStorage)) if (k.startsWith(${JSON.stringify(PREFIX)})) localStorage.removeItem(k);
        for (const [k, v] of Object.entries(b)) localStorage.setItem(k, v);
        return 1; })()`,
    ).catch(() => {});
    await send("Page.reload", { ignoreCache: true }).catch(() => {});
  }

  // Con el ws ya cerrado `evalJs` no resolvería nunca: tope de 3 s para no
  // colgar el proceso en la ruta de salida.
  const guarded = () =>
    Promise.race([restore(), new Promise((r) => setTimeout(r, 3000))]);
  const realExit = process.exit.bind(process);
  process.exit = (code) => {
    guarded().finally(() => realExit(code));
  };
  process.on("uncaughtException", (e) => {
    console.error(e);
    guarded().finally(() => realExit(1));
  });

  return restore;
}
