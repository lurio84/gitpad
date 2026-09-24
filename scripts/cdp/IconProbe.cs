// Mide los HICON reales de una ventana (WM_GETICON) — usarlo para comprobar
// que ICON_BIG no es nulo tras un cambio de setup() relacionado con iconos.
// Uso: Add-Type -Path IconProbe.cs; [IconProbe]::Probe(<pid>)
using System;
using System.Runtime.InteropServices;

public static class IconProbe {
    const int WM_GETICON = 0x007F;
    const int ICON_SMALL = 0;
    const int ICON_BIG = 1;
    const int ICON_SMALL2 = 2;
    const int GCL_HICON = -14;
    const int GCL_HICONSM = -34;

    [DllImport("user32.dll")]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll")]
    static extern IntPtr GetClassLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern int GetClassLong(IntPtr hWnd, int nIndex);

    [StructLayout(LayoutKind.Sequential)]
    struct ICONINFO {
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [DllImport("user32.dll")]
    static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

    [DllImport("gdi32.dll")]
    static extern int GetObject(IntPtr hgdiobj, int cbBuffer, ref BITMAP lpvObject);

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAP {
        public int bmType;
        public int bmWidth;
        public int bmHeight;
        public int bmWidthBytes;
        public short bmPlanes;
        public short bmBitsPixel;
        public IntPtr bmBits;
    }

    static string Describe(IntPtr hIcon, string label) {
        if (hIcon == IntPtr.Zero) return label + ": (nulo)";
        ICONINFO info;
        if (!GetIconInfo(hIcon, out info)) return label + ": GetIconInfo fallo";
        BITMAP bmp = new BITMAP();
        IntPtr target = info.hbmColor != IntPtr.Zero ? info.hbmColor : info.hbmMask;
        GetObject(target, Marshal.SizeOf(typeof(BITMAP)), ref bmp);
        int h = info.hbmColor != IntPtr.Zero ? bmp.bmHeight : bmp.bmHeight / 2;
        return string.Format("{0}: {1}x{2} ({3}bpp)", label, bmp.bmWidth, h, bmp.bmBitsPixel);
    }

    public static void Probe(int pid) {
        var proc = System.Diagnostics.Process.GetProcessById(pid);
        IntPtr hWnd = proc.MainWindowHandle;
        Console.WriteLine("hWnd=" + hWnd);

        IntPtr result;
        SendMessageTimeout(hWnd, WM_GETICON, (IntPtr)ICON_SMALL, IntPtr.Zero, 2, 1000, out result);
        Console.WriteLine(Describe(result, "WM_GETICON ICON_SMALL"));

        SendMessageTimeout(hWnd, WM_GETICON, (IntPtr)ICON_BIG, IntPtr.Zero, 2, 1000, out result);
        Console.WriteLine(Describe(result, "WM_GETICON ICON_BIG"));

        SendMessageTimeout(hWnd, WM_GETICON, (IntPtr)ICON_SMALL2, IntPtr.Zero, 2, 1000, out result);
        Console.WriteLine(Describe(result, "WM_GETICON ICON_SMALL2"));

        IntPtr classIcon = GetClassLongPtr(hWnd, GCL_HICON);
        Console.WriteLine(Describe(classIcon, "GCL_HICON (class)"));
        IntPtr classIconSm = GetClassLongPtr(hWnd, GCL_HICONSM);
        Console.WriteLine(Describe(classIconSm, "GCL_HICONSM (class)"));
    }
}
