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
entrelazados, revisar el diff de un commit o de un archivo, hacer stage/unstage
y commit, ver y hacer checkout de ramas, buscar commits por mensaje o por
contenido, fetch/pull/push, stash, cherry-pick y rebase simple — con detección
de conflicto y un banner para continuar o abortar la operación a medio camino.

## Fuera de alcance (v0)

Editor de conflictos 3-vías, rebase interactivo, PRs/issues de GitHub in-app,
LFS, submódulos, gestión de worktrees (crear/mover/borrar — sí se soportan de
forma pasiva: abrirlos y no romper el checkout), blame, macOS/Linux.

## Desarrollo

Requisitos: Node ≥ 20, Rust estable, MSVC Build Tools (C++), WebView2.

```bash
npm install
npm run tauri dev      # app en modo desarrollo
cd src-tauri && cargo test   # tests de parseo
npm run tauri build    # instalador NSIS de producción
```

Verificación E2E manual contra la app real (WebView2 no es controlable por
Playwright): ver [`scripts/cdp/README.md`](scripts/cdp/README.md).

## Estructura

```
src/                     frontend React
  App.tsx                pestañas, estado, stage/commit, ramas, búsqueda
  Graph.tsx               grafo de carriles (SVG, puro frontend)
  Diff.tsx                visor de diff
  App.css                estilos y tema oscuro
  api.ts                 wrappers tipados sobre invoke()
  types.ts               espejo de las structs de Rust
src-tauri/src/
  lib.rs                 comandos #[tauri::command]
  git/runner.rs          spawn de git, GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never
  git/repo.rs            log / status / branches / diff / stash / rebase / parseo
  git/error.rs           GitError -> { kind, message }
  git/tests.rs           tests de parseo
scripts/cdp/             scripts de verificación E2E vía Chrome DevTools Protocol
```
