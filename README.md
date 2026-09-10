# gitpad

Cliente Git de escritorio ligero para Windows. Sustituto gratuito y a medida de
GitKraken, cuyo plan gratuito no permite repos privados.

- **Tauri v2 + React + TypeScript.** Binario pequeño, arranque rápido (usa el
  WebView2 del sistema).
- **La capa Git llama al ejecutable `git`** (no libgit2): se heredan el Git
  Credential Manager, ssh-agent, hooks y `.gitconfig` del sistema. Toda invocación
  lleva `GIT_TERMINAL_PROMPT=0` para que un problema de credenciales sea un error y
  no un cuelgue.

## Estado

Fase 1 — lectura: abrir repo, lista de commits, panel de estado (`git status`).
Sin escritura todavía (commit, push, ramas → Fase 3). Sin grafo (Fase 2).

## Desarrollo

Requisitos: Node ≥ 20, Rust estable, MSVC Build Tools (C++), WebView2.

```bash
npm install
npm run tauri dev      # app en modo desarrollo
cd src-tauri && cargo test   # tests de parseo
```

## Estructura

```
src/                     frontend React
  api.ts                 wrappers tipados sobre invoke()
  types.ts               espejo de las structs de Rust
src-tauri/src/
  lib.rs                 comandos #[tauri::command]
  git/runner.rs          spawn de git, GIT_TERMINAL_PROMPT=0
  git/repo.rs            log / status / parseo
  git/error.rs           GitError -> { kind, message }
```
