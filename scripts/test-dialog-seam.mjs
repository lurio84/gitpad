// Guarda que nadie vuelva a llamar directamente a window.confirm/alert (no
// bloquean de verdad, ver 784867f) ni a importar @tauri-apps/plugin-dialog
// fuera de src/dialogs.ts (el único sitio que sabe del seam __E2E_DIALOG__
// que necesitan los scripts de scripts/cdp/). Node ≥ 22.18 ejecuta .mjs
// directamente. Sale con código 1 si algo falla.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const SEAM_FILE = "dialogs.ts";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLO"} — ${label}${extra ? `  [${extra}]` : ""}`);
  if (!cond) fails++;
};

for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replace(/\\/g, "/");
  const content = readFileSync(file, "utf8");
  check(`${rel}: sin window.confirm(`, !/window\.confirm\(/.test(content));
  check(`${rel}: sin window.alert(`, !/window\.alert\(/.test(content));
  if (rel !== SEAM_FILE) {
    // `open`/`save` (selector de archivos) sí se importan fuera del seam
    // (api.ts): solo confirm/message/ask son el problema, por el mismo
    // gotcha del IPC congelado que llevó a crear dialogs.ts.
    const imported = content.match(/import\s*\{([^}]*)\}\s*from\s*["']@tauri-apps\/plugin-dialog["']/)?.[1] ?? "";
    check(
      `${rel}: no importa confirm/message/ask de plugin-dialog directo (usa ./dialogs)`,
      !/\b(confirm|message|ask)\b/.test(imported),
    );
  }
}

console.log(fails === 0 ? "\n--- fin: TODO OK ---" : `\n${fails} FALLO(S)`);
process.exit(fails === 0 ? 0 : 1);
