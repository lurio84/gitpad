import type { Commit } from "./types";

/** Alto de fila en píxeles. Tiene que coincidir con el alto real de `.commit`
 * en App.css (`min-height`) para que el SVG quede alineado con la lista —
 * por eso `.commit` fija esa altura en vez de depender del contenido. */
export const ROW_H = 68;
const LANE_W = 16;
const DOT_R = 4;

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
}

/** Conecta cada commit con sus padres usando los carriles ya asignados. */
function buildEdges(commits: Commit[], rows: LaneRow[]): Edge[] {
  const rowByHash = new Map(rows.map((r, i) => [r.hash, i]));
  const edges: Edge[] = [];
  commits.forEach((c, i) => {
    const fromLane = rows[i].lane;
    for (const p of c.parents) {
      const toRow = rowByHash.get(p);
      if (toRow === undefined) {
        edges.push({ fromRow: i, fromLane, toRow: i, toLane: fromLane, boundary: true });
      } else {
        edges.push({ fromRow: i, fromLane, toRow, toLane: rows[toRow].lane, boundary: false });
      }
    }
  });
  return edges;
}

const COLORS = [
  "#4a9eff",
  "#e5c07b",
  "#98c379",
  "#c678dd",
  "#56b6c2",
  "#e06c75",
  "#61afef",
  "#d19a66",
];
const laneColor = (lane: number) => COLORS[lane % COLORS.length];

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
              stroke={laneColor(e.fromLane)}
              strokeWidth={2}
              strokeDasharray="2 3"
            />
          );
        }
        const x2 = cx(e.toLane);
        const y2 = cy(e.toRow);
        const color = laneColor(e.fromLane === e.toLane ? e.fromLane : e.toLane);
        if (x1 === x2) {
          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2} />
          );
        }
        // Fusión o bifurcación: curva en S de un carril a otro.
        const ymid = (y1 + y2) / 2;
        return (
          <path
            key={i}
            d={`M ${x1} ${y1} C ${x1} ${ymid}, ${x2} ${ymid}, ${x2} ${y2}`}
            fill="none"
            stroke={color}
            strokeWidth={2}
          />
        );
      })}
      {rows.map((r, i) => (
        <circle
          key={r.hash}
          cx={cx(r.lane)}
          cy={cy(i)}
          r={DOT_R}
          fill={laneColor(r.lane)}
        />
      ))}
    </svg>
  );
}
