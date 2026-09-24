// Extrae el icono real embebido en un .exe (grande/pequeño + el "shell",
// el que usa Explorador) para compararlo a ojo tras tocar iconos/NSIS.
// Uso: Add-Type -Path ExtractIcons.cs -ReferencedAssemblies System.Drawing
//      [ExtractIcons]::Dump("<ruta.exe>", "<carpeta salida>", "<prefijo>")
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public static class ExtractIcons {
    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    static extern uint ExtractIconEx(string szFileName, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);

    public static void Dump(string exePath, string outDir, string prefix) {
        var large = new IntPtr[1];
        var small = new IntPtr[1];
        ExtractIconEx(exePath, 0, large, small, 1);
        if (large[0] != IntPtr.Zero) {
            using (var ic = Icon.FromHandle(large[0])) {
                Console.WriteLine("large: " + ic.Width + "x" + ic.Height);
                using (var bmp = ic.ToBitmap()) bmp.Save(System.IO.Path.Combine(outDir, prefix + "_large.png"));
            }
        } else Console.WriteLine("large: nulo");
        if (small[0] != IntPtr.Zero) {
            using (var ic = Icon.FromHandle(small[0])) {
                Console.WriteLine("small: " + ic.Width + "x" + ic.Height);
                using (var bmp = ic.ToBitmap()) bmp.Save(System.IO.Path.Combine(outDir, prefix + "_small.png"));
            }
        } else Console.WriteLine("small: nulo");

        // También el icono asociado "shell" (el que usa Explorer, respeta el tamaño del sistema)
        using (var assoc = Icon.ExtractAssociatedIcon(exePath)) {
            Console.WriteLine("associated (shell): " + assoc.Width + "x" + assoc.Height);
            using (var bmp = assoc.ToBitmap()) bmp.Save(System.IO.Path.Combine(outDir, prefix + "_assoc.png"));
        }
    }
}
