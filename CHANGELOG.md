# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [Unreleased]

## [0.8.0] - 2026-09-20

Cierre de todo lo pendiente tras la v0.7.0: los huecos de producto que más
probablemente llevaran a abrir GitKraken, la deuda técnica, lo aplazado de las
versiones anteriores y una auditoría del código previo. Verificado contra la
app real por CDP (`scripts/cdp/cdp-v080.mjs`, 113 checks, 0 errores de consola),
`cargo test` (42 tests), `npm run test:unit` y CI en Windows.

### Added

- **Menú contextual** (clic derecho): en una rama (Checkout, Merge, Renombrar,
  Borrar), en un commit (Crear rama o tag aquí, Revert, Reset soft/mixed/hard),
  en un tag (Borrar) y en un archivo (Ver historial). También con teclado
  (Shift+F10 o la tecla de menú). Un **＋** visible junto a «Ramas» crea una
  rama en HEAD sin depender del clic derecho.
- **Merge explícito**: «Merge aquí» junto al rebase, para resolver una
  divergencia (`pull` sigue siendo `--ff-only`). Un conflicto reutiliza el banner
  de Continuar/Abortar.
- **Crear, renombrar y borrar ramas**; **crear y borrar tags** (ligeros y
  locales; el push de tags queda fuera). Borrar una rama no fusionada pide una
  segunda confirmación antes de forzar.
- **Historial de un archivo**: sigue renombrados y no muestra líneas de grafo
  (los padres reales no están en la lista filtrada). Es un lente pasajero, no
  se recuerda.
- **Revert** de un commit (no de una fusión) y **Reset** soft/mixed/hard. La
  confirmación de `--hard` **nombra** los archivos con cambios sin guardar que
  se pierden. El banner reconoce «Revert en curso».
- **Resaltado de palabras dentro de una línea** (word-diff) en las vistas lado a
  lado y unificada. No resalta líneas que se parecen poco ni las enormes.
- **Teclado y ARIA**: commits, archivos, ramas y pestañas se alcanzan con Tab y
  se activan con Enter/Espacio; en la lista de commits, una sola parada de Tab y
  flechas ↑/↓/Inicio/Fin. Pestañas con `tablist`/`tab`/`aria-selected`.
- CI en GitHub Actions (Windows): build del frontend, `test:unit` y `cargo test`.
- Registro de cierres inesperados en `%LOCALAPPDATA%\com.lurio84.gitpad\gitpad.log`
  (con `panic = "abort"` no quedaba ningún rastro).

### Changed

- Los chips de refs traen su tipo del backend (`--decorate=full`): una rama y un
  tag con el mismo nombre en el mismo commit ya no se confunden (el tag
  desaparecía), ni una rama local con `/` con una remota.
- La lista de commits vacía dice por qué («Ningún commit coincide con el
  filtro.») y las secciones sin nada dicen «Nada preparado» / «Nada sin preparar»
  en vez de un guion.
- Descartar cambios nombra los archivos que se pierden.
- El visor de «Todos los archivos» no lee blobs de más de 64 MiB y explica que
  un submódulo no se puede mostrar en vez de enseñar el `fatal` de git.

### Fixed

- **Rutas con corchetes**: un pathspec normal trata `[1]` como glob, así que
  preparar `a[1].txt` también preparaba `a1.txt`, y **descartar** se llevaba los
  cambios (o borraba el archivo sin seguir) de su hermano `a1.txt`. Ahora las
  rutas son literales en stage, unstage, descartar y los diffs.
- Un solo commit con el separador de campos en su mensaje rompía el log entero
  y el repo dejaba de abrirse.
- `checkout`, `rebase` y `push` no leen una rama o un remoto como opción de git
  (`--end-of-options`).
- Siete scripts de verificación CDP pisaban las pestañas reales al probar el
  binario de producción; ahora respaldan y restauran `localStorage`.

### Requisitos

- Git ≥ 2.24 (por `--end-of-options`).

## [0.7.0] - 2026-09-20

Cuarta ronda de feedback de Bernardo («Review 0.6.0»): los cinco puntos.
Verificado contra la app real por CDP (`scripts/cdp/cdp-v070.mjs`, 0 errores
de consola) y contra el binario de producción.

### Added

- **Resumen y Descripción** en el cuadro de commit (como GitKraken). Sin
  descripción se guarda solo el resumen; una descripción de solo espacios cuenta
  como vacía. Al marcar *amend* se precargan resumen y descripción del commit
  que se reescribe (antes se perdía el cuerpo); al desmarcar vuelve lo que
  hubiera escrito.
- **Paneles laterales redimensionables** arrastrando su borde (también con las
  flechas del teclado; doble clic restaura el ancho por defecto). El ancho se
  recuerda, y el panel central del diff conserva siempre un mínimo aunque el
  ancho guardado sea de otra pantalla o se achique la ventana.
- **Reordenar pestañas** arrastrándolas. El orden se recuerda.
- **Modo Lista / Árbol** en «Archivos del commit», recordado entre sesiones.
- **Todos los archivos** (el «View All Files» de GitKraken): pestaña en el panel
  derecho con el árbol completo del proyecto en el commit seleccionado (o en
  `HEAD` si no hay ninguno) y un visor con el contenido del archivo tal como
  estaba en ese commit. Archivos binarios y de más de 2 MB se avisan en vez de
  volcarse.

### Changed

- `dragDropEnabled: false` en la ventana: en Windows, Tauri intercepta el
  arrastre dentro de la página y rompe el drag & drop HTML5. gitpad no usa el
  arrastre de archivos desde el sistema.

## [0.6.0] - 2026-09-19

Repaso visual con identidad propia y tres huecos del flujo de revisión de
commits. Verificado contra el binario de producción (0 errores de consola).

### Added

- **Animaciones** (CSS puro, sin dependencias, respetan `prefers-reduced-motion`):
  el grafo se traza al abrir un repo o cambiar de pestaña (no en refrescos);
  barra de acento que crece al seleccionar un commit, un archivo o una pestaña;
  pulsación con rebote en Commit; pulso único del chip HEAD al cambiar de commit;
  entrada del banner de conflicto; esqueletos de carga en el diff y la lista de
  archivos (no aparecen hasta 150 ms) y barra de progreso bajo la barra superior.
- **Cargar más commits**: botón al final de la lista cuando hay más de 200.
  La selección se conserva y el refresco al volver a la ventana no encoge lo
  ya cargado.
- **Ver solo una rama**: botón ○/◉ en cada rama del panel (el clic en la rama
  sigue siendo checkout) y chip «Viendo solo X · ver todas». El nodo `//WIP` se
  oculta al ver una rama que no es la activa.
- Los chips de refs distinguen HEAD (relleno), rama local (contorno), remota
  (atenuada) y tag (contorno discontinuo).
- El SVG del icono vuelve al repo (`src-tauri/icons/source/`): se había perdido
  tras la v0.2.1 y no se podía regenerar. Con él, `npm run icon`.

### Changed

- Los botones en curso (Recargar, Fetch, Pull, Push, Stash…) ya no cambian su
  etiqueta por «…»: encogían el botón unos 50 px y desplazaban a todos los de su
  derecha en cada recarga. Ahora la etiqueta se queda y un spinner va encima.
- Ancho mínimo de ventana 640 → 900 px: las columnas necesitan 680 y a 640 el
  panel del diff quedaba a 0 con scroll horizontal.
- Grafo: el nodo `//WIP` ya no muestra la línea a través del círculo, y las
  aristas llevan el color de su rama (un nodo naranja ya no sale de una línea
  azul).
- Si la rama por la que se filtra desaparece (fetch con prune), se vuelve a ver
  todas en vez de dejar la pestaña con error.
- **Los commits de merge ya se pueden revisar**: listan sus archivos y enseñan
  el diff contra su primer padre (`-m --first-parent`). Antes daban lista y
  diff vacíos.
- Paleta y jerarquía nuevas: superficie en tres capas y ocho colores de carril
  de los que deriva el acento (antes: chrome estilo VS Code con carriles
  One Dark). Escala tipográfica de tres tamaños, sin mayúsculas en las
  etiquetas de sección.
- Botones y campos con estados de reposo, hover, active, foco visible y
  deshabilitado definidos una sola vez. Stage/unstage/descartar dejan de estar
  ocultos hasta el hover.
- Contraste: el acento sobre la fila seleccionada pasa de 3,5:1 a 5,5:1; el
  texto atenuado, de 4,7:1 a 7,3:1.
- Filas de commit más compactas (68 → 56 px) y fecha corta; la fecha larga se
  partía en la columna estrecha y se recortaba. `ROW_H` (`Graph.tsx`) es ahora
  la única fuente del alto de fila (`--row-h`).
- Diff lado a lado: los números de línea de 5 dígitos ya no se pisan con el
  texto.
- Icono rehecho sobre la paleta nueva (misma composición: placa oscura, carriles
  azul/naranja y el nodo `//WIP` en verde). El aro del `//WIP` va relleno de
  placa, no hueco: antes la arista se veía a través del círculo. Los marcos
  16/24/32 del `.ico` salen de una variante de trazo más grueso
  (`gitpad-small.svg`, sin `//WIP`), que a ese tamaño sí se lee; 48/64/256 salen
  del principal. `npm run icon` encadena todo (juego completo, variante pequeña, `.ico`,
  `public/favicon.ico`) en `src-tauri/icons/source/build-icons.mjs`; también
  quita el 404 de `/favicon.ico`.

## [0.5.0] - 2026-09-17

Bernardo pidió "implementar stage/unstage, commit, stash" creyendo que v0.4.0
era read-only — las tres ya existían desde v0.2.0. El problema real era que
gitpad no las ponía donde su memoria muscular de GitKraken las busca. Esta
versión no añade esas operaciones (ya estaban); las hace encontrables del
mismo modo que GitKraken, y cierra el único hueco funcional real que sí
faltaba (descartar cambios).

### Added
- **Nodo `//WIP` en el grafo de commits**, equivalente al de GitKraken:
  aparece arriba del todo cuando hay cambios sin comprometer y lo abre en el
  panel "Cambios" con un solo clic — antes había que reclicar el commit ya
  seleccionado, un gesto que nadie adivina sin que se documente.
- **Panel "Cambios" en dos secciones, Unstaged/Staged**, cada una con su
  propio **"Stage all"/"Unstage all"** siempre visible (no depende de hover).
  Los conflictos de merge/rebase se mantienen aparte, sin tocar ese flujo.
- **Stash y Pop en la barra superior**, junto a Fetch/Pull/Push — antes solo
  vivían al fondo de la columna derecha.
- **Descartar cambios** (🗑 por archivo): un archivo seguido vuelve al estado
  de HEAD (índice y árbol de trabajo a la vez); uno sin seguir se borra del
  disco. Irreversible — pide confirmación antes de ejecutar.

### Changed
- `RepoInfo` trae ahora `head_hash` (hash completo de HEAD), necesario como
  padre del nodo //WIP.

## [0.4.0] - 2026-09-16

### Added
- **FEAT-002** (segundo backlog de Bernardo): mensaje del commit en el panel
  derecho, asunto y cuerpo separados, encima del listado de archivos.
  `get_log` ahora trae también `%b`; solo se ampliaba el campo, sin comando
  nuevo.

## [0.3.1] - 2026-09-16

### Fixed
- **Solapamiento en la vista side-by-side** (segundo backlog de Bernardo):
  cada fila del diff era su propio contenedor de grid, así que las columnas
  no alineaban entre filas y el texto largo desbordaba su celda. El grid
  sube al contenedor por archivo.
- Esa misma vista, tras el fix de alineación, seguía obligando a scroll
  horizontal incluso en diffs cortos: las columnas se dimensionaban al
  contenido más largo de todo el archivo. Se cambia a `minmax(0,1fr)` +
  `white-space: pre-wrap`, así el texto envuelve dentro del ancho del panel.

### Added
- Zoom con `Ctrl +` / `Ctrl -` (WebView2 `zoomHotkeysEnabled`).
- Recarga automática de la lista de commits al recuperar el foco de la
  ventana, para cuando se commitea desde otra herramienta y se vuelve a
  gitpad. No usa el recargado completo para no perder el commit/diff
  seleccionado.

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

### Changed
- Repaso de traducciones de la UI: los términos que Bernardo se va a encontrar
  igual en `git`/GitKraken (Stage, Unstage, Rebase, Merge, Apply, side by
  side/unified) se dejan en inglés; el resto en español.

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
