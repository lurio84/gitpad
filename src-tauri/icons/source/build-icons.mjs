// Regenera todos los iconos desde las fuentes SVG de esta carpeta.
//   npm run icon
//
// `tauri icon` acepta una sola fuente, así que su icon.ico lleva la versión
// principal en todos los tamaños y a 16 px el trazo de 8 se queda en 0,5 px.
// Este script encadena todo lo necesario para no depender de acordarse:
//   1. juego completo desde gitpad.svg
//   2. borra android/ e ios/ (el CLI 2.11.4 no permite excluirlas; app de escritorio)
//   3. marcos 16/24/32 desde gitpad-small.svg (trazo grueso, sin nodo //WIP)
//   4. los mete en icon.ico sustituyendo los del principal
//   5. toca build.rs (fuerza a re-incrustar el icono en el .exe)
//   6. copia icon.ico a public/favicon.ico
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.join(here, "..");
const root = path.join(iconsDir, "..", "..");
const ico = path.join(iconsDir, "icon.ico");

function tauriIcon(args) {
  // Con `shell: true` (necesario para `npx` en Windows) los argumentos se
  // concatenan sin más: hay que entrecomillarlos por si la ruta lleva espacios.
  const quoted = args.map((x) => `"${x}"`);
  const r = spawnSync("npx", ["tauri", "icon", ...quoted], { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`tauri icon ${args.join(" ")} falló (${r.status})`);
}

tauriIcon([path.join(here, "gitpad.svg")]);
for (const d of ["android", "ios"]) fs.rmSync(path.join(iconsDir, d), { recursive: true, force: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitpad-icon-"));
try {
  tauriIcon([path.join(here, "gitpad-small.svg"), "-o", tmp, "-p", "16", "-p", "24", "-p", "32"]);

  const data = fs.readFileSync(ico);
  const n = data.readUInt16LE(4);
  const frames = new Map();
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    const size = data.readUInt32LE(e + 8);
    const off = data.readUInt32LE(e + 12);
    frames.set(data[e] || 256, data.subarray(off, off + size));
  }
  for (const f of frames.values()) {
    if (f.readUInt32BE(0) !== 0x89504e47) throw new Error("icon.ico trae marcos que no son PNG");
  }
  for (const s of [16, 24, 32]) frames.set(s, fs.readFileSync(path.join(tmp, `${s}x${s}.png`)));

  const sizes = [...frames.keys()].sort((a, b) => a - b);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); // tipo: icono
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    const f = frames.get(s);
    header[e] = header[e + 1] = s === 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4); // planos
    header.writeUInt16LE(32, e + 6); // bits por píxel
    header.writeUInt32LE(f.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += f.length;
  });
  fs.writeFileSync(ico, Buffer.concat([header, ...sizes.map((s) => frames.get(s))]));
  console.log("icon.ico:", sizes.join(", "));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Tauri incrusta el icono del .exe (recurso de Windows) desde build.rs, y cargo
// no lo reejecuta si solo cambian los PNG/ICO: el .exe salía con el icono
// viejo aunque el instalador llevase el nuevo. Tocar build.rs fuerza la
// recompilación del recurso.
const buildRs = path.join(root, "src-tauri", "build.rs");
const now = new Date();
fs.utimesSync(buildRs, now, now);

fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.copyFileSync(ico, path.join(root, "public", "favicon.ico"));
console.log("public/favicon.ico actualizado");
