import type { Commit } from "./types";

/** Alto de fila en píxeles. Fuente única: App.tsx lo publica como `--row-h` en
 * `.app` y `.commit` (App.css) lo usa como `height` fijo, así el SVG queda
 * alineado con la lista sin medir el DOM. Si una fila desborda, el CSS la
 * recorta en silencio: `scripts/cdp/cdp-row-height.mjs` lo detecta. */
export const ROW_H = 56;
const LANE_W = 16;
const DOT_R = 4;

/** Hash sintético del nodo //WIP que App.tsx antepone a la lista de commits
 * cuando hay cambios sin comprometer (equivalente al nodo WIP de GitKraken).
 * No es un hash real: nunca se manda a un comando git. */
export const WIP_HASH = "__WIP__";

export interface LaneRow {
  hash: string;
  lane: number;
}

/**
 * Asigna un carril (columna) a cada commit, procesando la lista de arriba a
 * abajo (más reciente primero). Requiere que ningún padre aparezca antes que
 * sus hijos — `--date-order` de git ya lo garantiza aunque mezcle ramas
 * (`--all`).
 *
 * Algoritmo goloso: `active[carril]` guarda el hash que ese carril espera ver
 * a continuación (un padre todavía no alcanzado). No busca el número mínimo
 * de carriles (un empaquetado óptimo es mucho más código para un repo de
 * escala personal) — solo evita cruces incorrectos.
 */
export function assignLanes(commits: Commit[]): LaneRow[] {
  const active: (string | null)[] = [];
  const rows: LaneRow[] = [];

  for (const c of commits) {
    let lane = active.indexOf(c.hash);
    if (lane === -1) {
      // Punta de rama nueva: nadie la esperaba todavía.
      lane = active.indexOf(null);
      if (lane === -1) lane = active.length;
    }
    // Si otro carril también esperaba este hash (dos ramas convergiendo en el
    // mismo commit), se cierra: la línea de ese carril termina aquí.
    for (let j = 0; j < active.length; j++) {
      if (j !== lane && active[j] === c.hash) active[j] = null;
    }
    rows.push({ hash: c.hash, lane });

    const [first, ...merges] = c.parents;
    active[lane] = first ?? null; // continuación recta, o se libera si es raíz.
    for (const p of merges) {
      if (active.includes(p)) continue; // ya lo espera otro carril existente.
      const free = active.indexOf(null);
      if (free === -1) active.push(p);
      else active[free] = p;
    }
  }
  return rows;
}

interface Edge {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
  /** El padre no está entre los commits cargados (corte de paginación). */
  boundary: boolean;
  /** Arista hacia un padre que no es el primero: la rama fusionada. */
  isMerge: boolean;
}

/** Conecta cada commit con sus padres usando los carriles ya asignados. */
function buildEdges(commits: Commit[], rows: LaneRow[]): Edge[] {
  const rowByHash = new Map(rows.map((r, i) => [r.hash, i]));
  const edges: Edge[] = [];
  commits.forEach((c, i) => {
    const fromLane = rows[i].lane;
    c.parents.forEach((p, pi) => {
      const toRow = rowByHash.get(p);
      const isMerge = pi > 0;
      if (toRow === undefined) {
        edges.push({ fromRow: i, fromLane, toRow: i, toLane: fromLane, boundary: true, isMerge });
      } else {
        edges.push({ fromRow: i, fromLane, toRow, toLane: rows[toRow].lane, boundary: false, isMerge });
      }
    });
  });
  return edges;
}

/** Los ocho carriles viven en App.css (`--lane-0` … `--lane-7`): son también la
 * fuente del acento de la interfaz, así que el color se pide por variable. */
const LANES = 8;
const laneColor = (lane: number) => `var(--lane-${lane % LANES})`;

/** Solo las primeras filas se animan al trazar el grafo (App.css `.intro`): son
 * las visibles, y animar cientos de trazos a la vez no compensa. `--i` escalona
 * la entrada por fila. */
const INTRO_ROWS = 14;
const igClass = (row: number) => (row < INTRO_ROWS ? "ig" : undefined);
const withRow = (style: Record<string, string>, row: number) =>
  ({ ...style, "--i": row }) as React.CSSProperties;

function cy(row: number) {
  return row * ROW_H + ROW_H / 2;
}
function cx(lane: number) {
  return lane * LANE_W + LANE_W / 2;
}

export function Graph({ commits }: { commits: Commit[] }) {
  const rows = assignLanes(commits);
  const edges = buildEdges(commits, rows);
  const maxLane = rows.reduce((m, r) => Math.max(m, r.lane), 0);
  const width = (maxLane + 1) * LANE_W;
  const height = commits.length * ROW_H;

  return (
    <svg
      className="graph"
      width={width}
      height={height}
      style={{ display: "block", flexShrink: 0 }}
    >
      {edges.map((e, i) => {
        const x1 = cx(e.fromLane);
        const y1 = cy(e.fromRow);
        if (e.boundary) {
          // Continúa fuera de la ventana cargada: un trazo corto discontinuo
          // en vez de una línea a ninguna parte.
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x1}
              y2={y1 + ROW_H / 2}
              style={{ stroke: laneColor(e.fromLane) }}
              strokeWidth={2}
              strokeDasharray="2 3"
            />
          );
        }
        const x2 = cx(e.toLane);
        const y2 = cy(e.toRow);
        // La línea es de la rama a la que pertenece: la del commit hijo cuando
        // va a su primer padre, la de la rama fusionada cuando es un merge. Así
        // un nodo naranja no sale de una línea azul.
        const color = laneColor(e.isMerge ? e.toLane : e.fromLane);
        if (x1 === x2) {
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              className={igClass(e.fromRow)}
              style={withRow({ stroke: color }, e.fromRow)}
              pathLength={1}
              strokeWidth={2}
            />
          );
        }
        // Fusión o bifurcación: curva en S de un carril a otro.
        const ymid = (y1 + y2) / 2;
        return (
          <path
            key={i}
            d={`M ${x1} ${y1} C ${x1} ${ymid}, ${x2} ${ymid}, ${x2} ${y2}`}
            fill="none"
            className={igClass(e.fromRow)}
            style={withRow({ stroke: color }, e.fromRow)}
            pathLength={1}
            strokeWidth={2}
          />
        );
      })}
      {rows.map((r, i) =>
        r.hash === WIP_HASH ? (
          // Hueco, no relleno: se lee como "todavía sin comprometer" (mismo
          // hash sintético que la fila de la lista, distinto trazo).
          <circle
            key={r.hash}
            cx={cx(r.lane)}
            cy={cy(i)}
            r={DOT_R}
            // Relleno del color del fondo, no `none`: con `none` la arista, que
            // arranca en el centro del nodo, se veía a través del círculo.
            className={igClass(i)}
            style={withRow({ fill: "var(--bg-0)", stroke: laneColor(r.lane) }, i)}
            strokeWidth={2}
          />
        ) : (
          <circle
            key={r.hash}
            cx={cx(r.lane)}
            cy={cy(i)}
            r={DOT_R}
            className={igClass(i)}
            style={withRow({ fill: laneColor(r.lane) }, i)}
          />
        ),
      )}
    </svg>
  );
}
