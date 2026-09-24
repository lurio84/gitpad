# gitpad

Cliente Git de escritorio ligero para Windows. Sustituto gratuito y a medida de
GitKraken, cuyo plan gratuito no permite repos privados.

- **Tauri v2 + React + TypeScript.** Binario pequeño, arranque rápido (usa el
  WebView2 del sistema).
- **La capa Git llama al ejecutable `git`** (no libgit2): se heredan el Git
  Credential Manager, ssh-agent, hooks y `.gitconfig` del sistema. Toda invocación
  lleva `GIT_TERMINAL_PROMPT=0` y `GCM_INTERACTIVE=never` para que un problema de
  credenciales sea un error legible y no un cuelgue esperando un prompt gráfico.

## Instalación

Requisito: tener **git for Windows** instalado (gitpad es un frontend sobre el
`git.exe` del sistema, sin él no arranca nada).

1. Descarga `gitpad_<versión>_x64-setup.exe` desde
   [Releases](https://github.com/lurio84/gitpad/releases).
2. Al abrirlo, Windows probablemente avise "Windows protegió tu PC" (SmartScreen,
   porque el instalador no está firmado). Pulsa **Más información** → **Ejecutar
   de todas formas**.
3. Sigue el instalador normal.
4. La primera vez que hagas push/pull/fetch de un repositorio privado, es
   posible que se abra tu navegador pidiéndote iniciar sesión en GitHub (una
   vez por máquina, ~1 minuto). Es normal: es el Git Credential Manager
   autenticándose.

## Qué hace

Abrir repos en pestañas (varias a la vez), ver el grafo de ramas con commits
entrelazados, revisar el diff de un commit o de un archivo, hacer stage/unstage,
descartar cambios y commit, ver y hacer checkout de ramas (o ver solo el
historial de una), revisar también los commits de merge, cargar más historia,
buscar commits por mensaje o por contenido, fetch/pull/push, stash, cherry-pick,
rebase simple y merge — con detección de conflicto y un banner para continuar o
abortar la operación a medio camino.

Con el clic derecho: crear, renombrar y borrar ramas; crear tags y borrarlos
en local y/o en el remoto; crear una rama o un tag en cualquier commit;
revert; reset soft/mixed/hard (la confirmación de `--hard` nombra lo que se
pierde); y el historial de un solo archivo, que sigue los renombrados. La
lista de Etiquetas (bajo Ramas) también permite subir un tag al remoto.
Pull/push funciona en cualquier rama local, no solo la activa. Ctrl+Enter
commitea y Ctrl+clic en un commit lo deselecciona.

Para revisar: los archivos de un commit en lista o en árbol, y una pestaña
«Todos los archivos» con el árbol completo del proyecto en ese commit y un visor
del contenido de cada archivo. El cuadro de commit separa Resumen y Descripción.
Los paneles laterales se ensanchan arrastrando su borde y las pestañas se
reordenan arrastrándolas. El diff resalta las palabras que cambian dentro de una
línea. Todo se maneja también con el teclado (Tab, Enter/Espacio, flechas en la
lista de commits, Shift+F10 para el menú contextual). Un botón «ⓘ» muestra la
versión instalada.

## Fuera de alcance (v0)

Editor de conflictos 3-vías, rebase interactivo, PRs/issues de GitHub in-app,
LFS, submódulos (aparecen como una ruta más y avisan de que no se pueden
mostrar), gestión de worktrees (crear/mover/borrar — sí se soportan de forma
pasiva: abrirlos y no romper el checkout), blame, comparar ramas, clonar,
macOS/Linux.

Requiere Git ≥ 2.24.

## Desarrollo

Requisitos: Node ≥ 20, Rust estable, MSVC Build Tools (C++), WebView2.

```bash
npm install
npm run tauri dev      # app en modo desarrollo
cd src-tauri && cargo test   # parseo y operaciones contra repos git reales
npm run test:unit      # módulos puros de TS (word-diff), sin runner de JS
npm run tauri build    # instalador NSIS de producción
npm run icon           # regenera los iconos desde src-tauri/icons/source/gitpad.svg
```

La ventana no baja de 900 px de ancho: es lo que suman los dos paneles laterales
en su mínimo (140 + 220) y el suelo de las dos columnas centrales (lista de
commits 220 + diff 260). Los anchos arrastrados se recortan contra el ancho de
ventana (`src/usePanels.ts`) para que el diff nunca se quede sin espacio.

`npm run icon` regenera todos los iconos desde los SVG de `src-tauri/icons/source`.
`tauri icon` acepta una sola fuente y a 16 px el trazo del icono principal se
desvanece, así que el script (`build-icons.mjs`) mete en el `.ico` los marcos
16/24/32 de una variante de trazo grueso, borra las carpetas `android/` e `ios/`
que el CLI genera sin querer y copia el `.ico` a `public/favicon.ico`.
Toca también `src-tauri/build.rs` para que el `.exe` re-incruste el icono. Tras
ejecutarlo, `icon.icns` sale distinto en cada pasada (el CLI no es determinista):
restaurarlo con `git checkout -- src-tauri/icons/icon.icns` si no se ha tocado el
SVG.

Verificación E2E manual contra la app real (WebView2 no es controlable por
Playwright): ver [`scripts/cdp/README.md`](scripts/cdp/README.md).

## Estructura

```
src/                     frontend React
  App.tsx                pestañas, estado, stage/commit, ramas, búsqueda
  Graph.tsx               grafo de carriles (SVG, puro frontend)
  Diff.tsx                visor de diff
  FileTree.tsx            árbol plegable de rutas (archivos del commit y «Todos los archivos»)
  FileView.tsx            visor del contenido de un archivo en un commit
  usePanels.ts            anchos arrastrables de los paneles laterales, con clamp
  App.css                estilos y tema oscuro
  api.ts                 wrappers tipados sobre invoke()
  types.ts               espejo de las structs de Rust
src-tauri/src/
  lib.rs                 comandos #[tauri::command]
  git/runner.rs          spawn de git, GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never
  git/repo.rs            log / status / branches / diff / stash / rebase / parseo
  git/error.rs           GitError -> { kind, message }
  git/tests.rs           tests de parseo
src-tauri/icons/
  source/                SVG del icono + build-icons.mjs (fuente de los .png/.ico)
scripts/cdp/             scripts de verificación E2E vía Chrome DevTools Protocol
```
