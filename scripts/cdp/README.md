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
   - `cdp-shots.mjs <repo> <dir-salida> <prefijo> [conflict]` — recorrido de revisión de
     un commit (árbol de trabajo → commit → archivo side-by-side → unificado → merge) con
     una captura por estado, para comparar antes/después de un cambio visual. Con
     `conflict`, solo el estado del banner (repo con rebase parado por conflicto).
   - `cdp-log-view.mjs <repo> <rama>` — «Cargar más commits» y filtro por rama: 3 páginas
     (200/400/todo), selección conservada al cargar más, refresco por foco sin encoger la
     lista, chip «Viendo solo X», sin checkout al filtrar. Necesita un repo de >400
     commits en la rama activa y otra rama con historial propio.
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
   - `cdp-split-diff.mjs <ruta-a-un-repo> <hash-de-commit>` — vista side-by-side:
     alineación de columnas entre filas de un mismo archivo, ausencia de
     solapamiento entre `.split-ln`/`.split-text`, y si el panel necesita scroll
     horizontal (avisa, no falla — un commit con líneas muy largas sí lo necesita
     legítimamente).
   - `node cdp-v070.mjs` — v0.7.0 completa, **sin argumentos** (crea sus dos repos de
     prueba en el directorio temporal y los borra): commit con Resumen+Descripción y
     amend, reordenar pestañas, paneles redimensionables con su clamp, modo árbol y
     «Todos los archivos». **Sale con código 1** si falla un check o hay un error de
     consola. Acepta dev y producción. El
     reordenado de pestañas usa drag nativo interceptado por CDP: cubre la lógica y
     `draggable`, pero no el flag `dragDropEnabled` de Tauri, que va por debajo de CDP.
   - `node cdp-v080.mjs` — v0.8.0 completa, **sin argumentos** (crea sus repos de
     prueba y los borra): merge (limpio, conflicto+abortar, conflicto+continuar), ramas
     y tags con menú contextual, historial de un archivo, revert y reset, word-diff,
     teclado/ARIA (con eventos de teclado reales de CDP), estados vacíos y la
     confirmación de descartar. 113 checks; sale con código 1 si falla alguno o hay un
     error de consola. Restaura `localStorage` (vía `_ls.mjs`). Acepta dev y producción.
     Los `window.confirm`/`prompt` se sobrescriben en la página; el `prompt` nativo se
     comprobó aparte con un diálogo real de WebView2.
   - `node cdp-v090.mjs` — v0.9.0 completa, **sin argumentos** (crea un remoto `bare`
     + dos clones y los borra): About, Ctrl+Enter, Ctrl+clic/reclic para deseleccionar,
     centro colapsado/expandido, lista de Etiquetas con menú (push/borrado remoto de
     tag, tag y rama homónimos), pull/push de una rama que no es la activa, botón "⋯"
     visible (también activado con `clientX/Y` en 0, como el teclado), y el hueco
     histórico del proyecto — fetch/pull/push, stash y cherry-pick — que nunca tuvo
     un script E2E persistido. Sale con código 1 si falla algo o hay error de consola.
     Restaura `localStorage`. `window.alert` también se sobrescribe (bloquearía
     `Runtime.evaluate`), con el mismo patrón de cola que `confirm`/`prompt`.
   - Aceptan como target tanto `localhost:1420` (dev) como `tauri.localhost`
     (binario de producción), sin tocar nada: `cdp-split-diff`, `cdp-graph`,
     `cdp-row-height`, `cdp-log-view` y `cdp-shots`. Los demás (`cdp-e2e`,
     `cdp-dom`, `cdp-shot`, `cdp-commit-files`) solo miran a dev; si hace falta
     pasarlos contra el binario, copiar de ellos esa línea del `find`.
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

## Confirmaciones/avisos nativos (`confirm`/`message` de `@tauri-apps/plugin-dialog`)

`window.__TAURI_INTERNALS__.invoke` está **congelado** (`writable:false`,
`configurable:false` en todas sus props salvo `plugins`) — comprobado en vivo,
un script E2E no puede interceptar el IPC desde JS de página. Por eso
`src/dialogs.ts` es el único punto de la app que llama a `confirm`/`message`
del plugin, y mira primero `window.__E2E_DIALOG__`: si existe (lo instala
`_dialog-mock.mjs` en `reloadWith`), lo usa en vez del diálogo real. **Toda
suite que recargue la página con `Page.reload` fuera de su `reloadWith` debe
volver a llamar `installDialogMock(ev)` después** — si no, la siguiente
confirmación abre un diálogo nativo real que CDP no ve (pasó una vez en
`cdp-v080.mjs`, tanda 2f).

`window.prompt` (crear/renombrar rama) es distinto: no lo toca el plugin, así
que `_dialog-mock.mjs` sigue sobrescribiéndolo directamente. **Ojo con esto: un
`window.prompt()` real con el depurador CDP enganchado no muestra ningún
diálogo y cuelga el proceso entero de gitpad de forma irrecuperable** —
ningún `Runtime.evaluate` nuevo responde, ni siquiera `Page.enable`. Pasó al
provocar un rename sin haber sembrado el mock primero. Si ocurre: matar
`gitpad.exe` (y el `node`/`cargo` de `tauri dev`) por PID verificado y
relanzar; no hay forma de recuperar la sesión desde fuera.

**Antes de una release, contra el `.exe` final** (no contra `tauri dev`: los
bugs de esta familia — capabilities, la CSP de v0.2.1 — solo aparecen en el
binario empaquetado), pasar a mano el arnés sobre los diálogos NATIVOS (sin
mock) con `dialog-drive.mjs` + `native-dialog-click.ps1` — es la única
comprobación que ejercita de verdad el IPC hacia Rust y el diálogo real de
Windows en vez del seam. Con `WEBVIEW2_USER_DATA_FOLDER` aislado (no tocar
el perfil real) y un repo de prueba desechable con un remoto `bare` y un tag
ya subido:

```
node scripts/cdp/dialog-drive.mjs <repo> seed
node scripts/cdp/dialog-drive.mjs x discard          # dispara el diálogo real de 🗑
powershell scripts/cdp/native-dialog-click.ps1 -OwnerPid <pid> -Action find
powershell scripts/cdp/native-dialog-click.ps1 -OwnerPid <pid> -Action click -ButtonText Cancelar   # → archivo intacto
powershell scripts/cdp/native-dialog-click.ps1 -OwnerPid <pid> -Action click -ButtonText Aceptar    # → archivo descartado
node scripts/cdp/dialog-drive.mjs x about
powershell scripts/cdp/native-dialog-click.ps1 -OwnerPid <pid> -Action click -ButtonText Aceptar
node scripts/cdp/dialog-drive.mjs x deletetag <nombre>   # diálogo de 3 botones (doDeleteTag)
powershell scripts/cdp/native-dialog-click.ps1 -OwnerPid <pid> -Action click -ButtonText "Cancelar"              # → no toca nada
powershell scripts/cdp/native-dialog-click.ps1 -OwnerPid <pid> -Action click -ButtonText "Solo en local"         # → borra local, deja el remoto
powershell scripts/cdp/native-dialog-click.ps1 -OwnerPid <pid> -Action click -ButtonText "En local y en el remoto"  # → borra los dos
```

`native-dialog-click.ps1` clica con `BM_CLICK` (mensaje Win32 directo al
control), **no mueve el ratón ni la ventana**: no hace falta avisar antes de
lanzarlo. `Action click` no da el clic por bueno solo por el código de
salida de `SendMessage` — sondea `IsWindow` hasta 2 s y solo dice `CLOSED` si
el diálogo de verdad desapareció; con más de un diálogo abierto a la vez se
niega a pulsar nada (`MULTIPLE_DIALOGS`) en vez de pulsar el mismo botón en
todos. El diálogo es MODAL (`MAIN_WINDOW_ENABLED=False` mientras está
abierto, comprobado con `IsWindowEnabled` de la ventana principal). Usar
siempre el PID del `.exe` de prueba, no el de una instancia real de Lucas si
tiene alguna abierta.

Las seis salidas (descartar × Cancelar/Aceptar, About, borrar tag ×
Cancelar/Solo en local/En local y en el remoto) se verificaron en vivo
contra el `.exe` de release real (`v0.9.0`, `tauri.localhost`), con el
cierre del diálogo confirmado por `IsWindow` en cada una y el resultado
contrastado contra `git tag --list`/`ls-remote`, no solo contra el texto
que imprime el script.

**Nota histórica**: un intento anterior con clic de ratón físico
(`SetCursorPos`/`SendInput`) parecía funcionar en una sesión y fallar en
otra sin motivo aparente — resultó que el entorno de esta herramienta no
tiene acceso real al escritorio interactivo (`GetCursorPos` después de
`SetCursorPos(x,y)` seguía devolviendo el centro de la pantalla sin
moverse, con `SetCursorPos`/`SendInput` reportando éxito los dos). `BM_CLICK`
no depende de eso — manda el mensaje directo a la ventana del botón — y es
el método correcto para este caso, no un segundo intento.

**Gotcha de PowerShell, ya corregido pero anotado por si reaparece en un
script nuevo**: `$algo = $lista | Where-Object {...}` con **un solo match**
devuelve un STRING SUELTO, no un array de un elemento — `$algo[0]` saca
entonces el primer CARÁCTER del string, no el elemento. Con eso, un hwnd
construido a partir de ese "primer carácter" cae en un handle inválido:
`GetWindowRect` no lanza excepción, simplemente devuelve `(0,0,0,0)` en
silencio, y el clic aterriza en la esquina de la pantalla sin tocar nada
— ningún error visible, solo un test que parece pasar pero no hizo nada.
Forzar array con `@(...)` alrededor de todo `Where-Object` cuyo resultado
se vaya a indexar.

## Notas

- **`localStorage` se respalda y se restaura.** Los scripts que siembran pestañas
  (`cdp-graph`, `cdp-dom`, `cdp-row-height`, `cdp-log-view`, `cdp-shots`,
  `cdp-split-diff`, `cdp-commit-files`) usan `_ls.mjs`: guardan las claves `gitpad:*`
  antes de sembrar y las devuelven al terminar, también si el script falla a medias
  (`process.exit` o excepción), y recargan la página para que el estado en memoria
  no las vuelva a pisar. Contra `tauri dev` da igual (origen `localhost:1420`); contra
  el binario de producción (`tauri.localhost`) es lo que evita llevarse las pestañas
  reales de quien lo usa. `cdp-v070.mjs` trae su propia copia del mismo patrón.
- **Estos scripts se ejecutan de uno en uno.** Todos se conectan a la MISMA
  página del WebView y siembran `localStorage` antes de recargar, así que dos a
  la vez se pisan la pestaña y dan fallos que no existen.
- Varios mutan el fixture: `cdp-e2e` y `cdp-dom` hacen checkout de rama, y el
  recorrido de revisión deja la pestaña donde la dejó. Si se van a comparar
  capturas contra una tanda anterior, comprobar antes con `git -C <fixture>
  status` que el árbol sigue en el estado en que se tomó la línea base (un
  `//WIP` perdido cambia el panel derecho entero).
- Los repos de fixture (con worktrees, tags/ramas homónimos, merges reales) se
  construyen aparte con `git init`/`git worktree add`/etc. en un directorio
  temporal — no están versionados aquí porque son desechables. Ver el historial de
  commits de Fase 2/3 para los pasos exactos si hace falta reconstruir uno.
- `ROW_H` (`src/Graph.tsx`) es la única fuente del alto de fila: `App.tsx` la publica
  como `--row-h` en `.app` y `.commit` (`App.css`) la usa como `height`. `cdp-graph.mjs`
  la lee del DOM. Tras tocar tipografía o padding de `.commit`, pasar `cdp-row-height.mjs`.
