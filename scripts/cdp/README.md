# Scripts de verificación E2E vía CDP

gitpad abre una ventana WebView2 nativa: Playwright no la controla. Estos scripts
verifican la app real (no mocks) conectando por Chrome DevTools Protocol al puerto
de depuración de WebView2.

## Cómo usarlos

1. Lanzar la app con el puerto de depuración abierto:
   ```
   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
   ```
   (en PowerShell: `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; npm run tauri dev`)
2. Esperar a que `curl http://localhost:9222/json` devuelva una página con
   `"url": "http://localhost:1420/"` (el arranque de `cargo` tarda unos segundos).
3. Ejecutar el script que toque:
   - `node cdp-e2e.mjs <ruta-a-un-repo>` — invoke directo (`open_repo`, `get_branches`,
     `checkout_branch`, `get_log` con filtro): checkout de rama, checkout de rama
     bloqueada por worktree, búsqueda por mensaje/contenido.
   - `node cdp-dom.mjs <ruta-a-un-repo>` — mismo flujo pero por el DOM real (siembra
     `localStorage` con la pestaña, recarga, clica elementos): prueba que la UI
     conectada de verdad funciona, no solo el backend.
   - `node cdp-graph.mjs <ruta-a-un-repo>` — el más reutilizable: extrae la
     geometría del SVG del grafo (círculos + líneas/paths) y la compara, arista por
     arista, contra `git log --all --parents`. Sirve para cualquier repo con merges
     reales, no solo el fixture con el que se escribió.
   - `node cdp-row-height.mjs <ruta-a-un-repo>` — detecta filas de `.commit` cuyo
     `scrollHeight` supera el `clientHeight` (contenido recortado en silencio por la
     altura fija que necesita el grafo para alinearse). Usado para pillar la
     regresión de altura de Fase 3 (44px no bastaba, hacían falta 68px).
   - `cdp-shot.mjs <ruta-de-salida.png>` — captura de pantalla + errores de consola
     posteriores a la conexión (para pillar violaciones de CSP, 404, etc.).
   - `cdp-commit-files.mjs <ruta-a-un-repo>` — FEAT-001 (listado de archivos de un
     commit, diff de un solo archivo, toggle side-by-side/unified): clic en un
     commit con varios archivos, clic en uno de ellos, comprueba que el diff queda
     filtrado a ese archivo, prueba el toggle y su persistencia en `localStorage`,
     y que un commit de merge no rompe nada. El fixture necesita un commit
     multi-archivo y uno de merge; para probar renombrados (necesitan `orig_path`
     para que git empareje el rename, ver `commit_file_diff` en `repo.rs`) o rutas
     no-ASCII, añadir esos commits al repo de fixture a mano.
   - También sirve para verificar el **binario de producción** (`npm run tauri
     build`, sin `--no-bundle`): la URL cambia de `http://localhost:1420` a
     `http://tauri.localhost`, y hace falta borrar
     `%LOCALAPPDATA%\<identifier>\EBWebView` (el `identifier` de `tauri.conf.json`)
     si ya se lanzó antes el mismo binario sin el puerto de depuración — WebView2
     solo lee `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` la primera vez que crea ese
     perfil. Ojo: esa carpeta es el `localStorage` real de la app (pestañas
     abiertas, modo de diff) — borrarla se lleva por delante cualquier sesión de
     uso real, no solo la de pruebas.
4. Al terminar, matar los procesos **por PID verificado** (nunca por nombre):
   ```
   Get-CimInstance Win32_Process -Filter "Name='gitpad.exe'" | Select ProcessId
   Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cargo.exe'" | Where-Object { $_.CommandLine -match 'gitpad|tauri' } | Select ProcessId, CommandLine
   Stop-Process -Id <pid> -Force
   ```

## Notas

- Los repos de fixture (con worktrees, tags/ramas homónimos, merges reales) se
  construyen aparte con `git init`/`git worktree add`/etc. en un directorio
  temporal — no están versionados aquí porque son desechables. Ver el historial de
  commits de Fase 2/3 para los pasos exactos si hace falta reconstruir uno.
- `ROW_H` en `cdp-graph.mjs`/`cdp-row-height.mjs` debe coincidir con la constante
  `ROW_H` de `src/Graph.tsx` y con la `height` de `.commit` en `src/App.css` — si se
  toca uno, tocan los tres.
