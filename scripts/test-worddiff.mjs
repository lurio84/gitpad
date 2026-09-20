// Pruebas de `src/wordDiff.ts` (módulo puro). Node ≥ 22.18 ejecuta el .ts
// directamente (type stripping). No hay runner de JS en el proyecto a propósito:
//   node scripts/test-worddiff.mjs        (sale con código 1 si algo falla)
import { MAX_CELLS, wordDiff } from "../src/wordDiff.ts";

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK   " : "FALLO"} — ${label}${extra ? `  [${extra}]` : ""}`);
  if (!cond) fails++;
};
const changed = (segs) => segs.filter((s) => s.changed).map((s) => s.text);
const join = (segs) => segs.map((s) => s.text).join("");

// Un cambio de valor: solo lo que cambia, no la línea entera.
let r = wordDiff("const total = 1;", "const total = 2;");
check("cambio de un valor: solo «1»/«2»", JSON.stringify([changed(r.a), changed(r.b)]) === '[["1"],["2"]]', JSON.stringify([changed(r.a), changed(r.b)]));

// Una palabra insertada: el lado viejo no marca nada, el nuevo marca lo añadido.
r = wordDiff("foo bar baz", "foo qux bar baz");
check("inserción: el lado viejo queda sin marcar", changed(r.a).length === 0, JSON.stringify(changed(r.a)));
check("inserción: el lado nuevo marca «qux »", JSON.stringify(changed(r.b)) === '["qux "]', JSON.stringify(changed(r.b)));

// Renombrar un identificador que aparece dos veces.
r = wordDiff("return calcula(x) + calcula(y);", "return computa(x) + computa(y);");
check("renombrado: marca las dos apariciones", JSON.stringify(changed(r.a)) === '["calcula","calcula"]' && JSON.stringify(changed(r.b)) === '["computa","computa"]', JSON.stringify([changed(r.a), changed(r.b)]));

// Unicode: una palabra con tilde es UNA palabra, no se parte por la «é».
r = wordDiff("café au lait", "café au lit");
check("unicode: «lait»→«lit», «café» intacto", JSON.stringify([changed(r.a), changed(r.b)]) === '[["lait"],["lit"]]', JSON.stringify([changed(r.a), changed(r.b)]));

// Líneas casi sin nada en común: sin resaltado (ruido).
check("líneas distintas: null", wordDiff("alpha beta gamma delta", "1 2 3 4 5 6 7 8 9") === null);
// Líneas enormes: sin resaltado (no colgar la UI).
const gorda = Array.from({ length: 300 }, (_, i) => `t${i}`).join(" ");
check(`por encima de ${MAX_CELLS} celdas: null`, wordDiff(gorda, gorda + " extra") === null);
// Idénticas: nada marcado.
r = wordDiff("igual igual", "igual igual");
check("idénticas: nada marcado", changed(r.a).length === 0 && changed(r.b).length === 0);
// Vacías: no revienta.
check("cadenas vacías: no lanza", (() => { try { wordDiff("", ""); wordDiff("a", ""); wordDiff("", "b"); return true; } catch { return false; } })());

// Propiedad: los segmentos SIEMPRE reconstruyen las cadenas. Los pares se generan
// CORRELACIONADOS (b = a con unas pocas ediciones): con cadenas independientes casi
// todo se descarta por poco parecido y la prueba no probaría nada.
const alfabeto = ["foo", " ", "bar", "  ", "x", "1", ";", "(", ")", "é", "\t", "=", "baz", "\r"];
const pick = () => alfabeto[Math.floor(Math.random() * alfabeto.length)];
const tokens = (n) => Array.from({ length: n }, pick);
function muta(ts) {
  const t = [...ts];
  for (let e = 0, n = 1 + Math.floor(Math.random() * 3); e < n; e++) {
    const i = Math.floor(Math.random() * (t.length + 1));
    const op = Math.floor(Math.random() * 3);
    if (op === 0) t.splice(i, 0, pick());
    else if (op === 1 && t.length > 1) t.splice(Math.min(i, t.length - 1), 1);
    else if (t.length) t[Math.min(i, t.length - 1)] = pick();
  }
  return t;
}
let bien = 0, nulos = 0, malo = null;
for (let k = 0; k < 800 && !malo; k++) {
  const base = tokens(6 + Math.floor(Math.random() * 40));
  const a = base.join(""), b = muta(base).join("");
  const d = wordDiff(a, b);
  if (d === null) { nulos++; continue; }
  const alterna = (segs) => segs.every((s, i) => i === 0 || segs[i - 1].changed !== s.changed);
  if (join(d.a) === a && join(d.b) === b && alterna(d.a) && alterna(d.b)) bien++;
  else malo = [a, b];
}
check("propiedad: los segmentos reconstruyen la cadena original y se fusionan", malo === null, malo ? JSON.stringify(malo) : `${bien} con resaltado, ${nulos} descartados`);
check("propiedad: la mayoría de los casos SÍ se resaltan (la prueba no es vacua)", bien > 600, `${bien}/800`);

// Rendimiento: el peor caso PERMITIDO (justo por debajo de MAX_CELLS) no debe notarse.
// 250 palabras = 499 tokens por lado → 249 001 celdas ≤ 250 000. (Con 300 palabras el
// caso supera el tope, sale por `null` sin calcular y el tiempo no significaría nada.)
const tope = Array.from({ length: 250 }, (_, i) => `p${i}`).join(" ");
const tope2 = Array.from({ length: 250 }, (_, i) => (i % 3 ? `p${i}` : `q${i}`)).join(" ");
const t0 = performance.now();
const dTope = wordDiff(tope, tope2);
const ms = performance.now() - t0;
check("el peor caso permitido SÍ se calcula (no es null)", dTope !== null);
check("el peor caso permitido tarda < 50 ms", ms < 50, `${ms.toFixed(1)} ms`);

console.log(`--- fin: ${fails === 0 ? "TODO OK" : `${fails} fallo(s)`} ---`);
process.exit(fails === 0 ? 0 : 1);
