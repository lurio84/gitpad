# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [Unreleased]

## [0.3.0] - 2026-09-16

### Added
- **FEAT-001** (primer backlog de Bernardo): revisión de un commit completa.
  - Listado de archivos tocados por un commit (`get_commit_files`), con
    renombrados y rutas no-ASCII correctos.
  - Clic en un archivo del commit para ver solo su diff (`get_commit_file_diff`),
    incluidos los renombrados (necesita la ruta vieja para que git empareje el
    rename en vez de mostrar un archivo nuevo).
  - Vista de diff lado a lado (por defecto, como en GitKraken) con toggle a
    unificado, persistido entre sesiones.
  - Reclicar el commit ya seleccionado vuelve al panel de cambios del árbol de
    trabajo (antes quedaba inalcanzable hasta cerrar la pestaña).

### Fixed
- Rutas no-ASCII en la cabecera del diff de un commit salían octal-escapadas
  (`caf\303\251.txt`); se añade `-c core.quotePath=false`.

## [0.2.1] - 2026-09-13

### Added
- Icono propio (sustituye al de Tauri por defecto).
- Publisher, copyright y descripción en el instalador NSIS.
- LICENSE (MIT) y este CHANGELOG.

### Changed
- README reescrito: instala/qué hace/fuera de alcance en vez del estado de Fase 1.

## [0.2.0] - 2026-09-13

### Added
- Fetch / pull / push in-app.
- Stash, cherry-pick y rebase simple, con detección de conflicto y banner
  Continuar/Abortar.
- Empaquetado NSIS (`gitpad_0.2.0_x64-setup.exe`).

### Fixed
- `GIT_TERMINAL_PROMPT=0` no evita que el Git Credential Manager abra su
  propio prompt gráfico ante una credencial no cacheada; se añade
  `GCM_INTERACTIVE=never` para que falle rápido con un mensaje legible.
- `op_state` no se refrescaba tras un fallo de rebase/cherry-pick por
  conflicto, dejando el banner sin aparecer hasta recargar a mano.

## Historial de desarrollo previo (sin versión etiquetada)

- Pestañas multi-repo, visor de diff, stage/unstage/commit, panel de ramas
  con checkout y búsqueda de commits por mensaje/contenido.
- Grafo de ramas en carriles (SVG, verificado arista por arista contra
  `git log --all --parents` en un repo con merge real).
- Esqueleto inicial: abrir repo, lista de commits, panel de `git status`.
