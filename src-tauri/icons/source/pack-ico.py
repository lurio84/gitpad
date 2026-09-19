"""Reempaqueta icon.ico usando la variante pequeña (gitpad-small.svg) en 16/24/32 px.

`tauri icon` acepta una sola fuente, así que su icon.ico lleva la versión
principal en todos los tamaños y a 16 px el trazo de 8 se queda en 0,5 px. Este
script sustituye solo los marcos 16/24/32. Ejecutarlo SIEMPRE tras `npm run icon`.

    npm run icon
    npx tauri icon src-tauri/icons/source/gitpad-small.svg -o <tmp> -p 16 -p 24 -p 32
    python src-tauri/icons/source/pack-ico.py <tmp>
"""
import os
import struct
import sys

ICO = os.path.join(os.path.dirname(__file__), "..", "icon.ico")
small_dir = sys.argv[1]

data = open(ICO, "rb").read()
n = struct.unpack("<H", data[4:6])[0]
frames = {}
for i in range(n):
    w, _h, _cc, _res, _pl, _bpp, size, off = struct.unpack("<BBBBHHII", data[6 + 16 * i : 6 + 16 * (i + 1)])
    frames[w or 256] = data[off : off + size]
assert all(f[:8] == b"\x89PNG\r\n\x1a\n" for f in frames.values()), "hay marcos que no son PNG"

for s in (16, 24, 32):
    frames[s] = open(os.path.join(small_dir, f"{s}x{s}.png"), "rb").read()

sizes = sorted(frames)
out = struct.pack("<HHH", 0, 1, len(sizes))
header_end = 6 + 16 * len(sizes)
body = b""
for s in sizes:
    b = frames[s]
    dim = 0 if s == 256 else s
    out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(b), header_end + len(body))
    body += b
open(ICO, "wb").write(out + body)
print("icon.ico:", sizes)
