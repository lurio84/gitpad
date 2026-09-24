# Clica un botón de un diálogo nativo de Windows (#32770, los que abre
# tauri-plugin-dialog) con un clic de ratón REAL (SendInput), no con mensajes
# Win32 simulados: BM_CLICK y WM_COMMAND se comprobaron en vivo contra estos
# diálogos y NO los cierran de forma fiable (a veces no hacen nada, a veces
# disparan el botón por defecto en vez del pedido). Solo el clic real funciona.
#
# Uso:
#   dlg = & native-dialog-click.ps1 -OwnerPid <pid> -Action find
#   & native-dialog-click.ps1 -OwnerPid <pid> -Action click -ButtonText "Cancelar"
#
# MUEVE EL CURSOR DE VERDAD. Avisar antes de lanzarlo si alguien puede estar
# usando el ratón en ese momento.
param(
  [Parameter(Mandatory=$true)][int]$OwnerPid,
  [Parameter(Mandatory=$true)][ValidateSet("find","click")]$Action,
  [string]$ButtonText
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class NativeDialog {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    // Recolecta primero (results como texto plano "hwnd|pid|clase|título") y
    // resuelve nombres de proceso DESPUÉS, fuera del callback: llamar a
    // Get-Process (u otro cmdlet) DENTRO del delegado de EnumWindows pierde
    // resultados en silencio (comprobado en vivo).
    public static List<string> ListVisibleTopLevel() {
        var results = new List<string>();
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                var tb = new StringBuilder(512);
                GetWindowText(hWnd, tb, 512);
                var cb = new StringBuilder(256);
                GetClassName(hWnd, cb, 256);
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                results.Add(hWnd + "|" + pid + "|" + cb.ToString() + "|" + tb.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }

    public static List<string> ListChildButtons(IntPtr parent) {
        var results = new List<string>();
        EnumChildWindows(parent, (hWnd, lParam) => {
            var cb = new StringBuilder(256);
            GetClassName(hWnd, cb, 256);
            if (cb.ToString() == "Button") {
                var tb = new StringBuilder(256);
                GetWindowText(hWnd, tb, 256);
                results.Add(hWnd + "|" + tb.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }
}
"@

$dialogs = [NativeDialog]::ListVisibleTopLevel() | Where-Object {
    $p = $_ -split '\|', 4
    [int]$p[1] -eq $OwnerPid -and $p[2] -eq "#32770"
}
if ($dialogs.Count -eq 0) { Write-Output "NONE"; exit 0 }

$mainWin = [NativeDialog]::ListVisibleTopLevel() | Where-Object {
    $p = $_ -split '\|', 4
    [int]$p[1] -eq $OwnerPid -and $p[2] -eq "Tauri Window"
}
if ($mainWin.Count -gt 0) {
    $mainHwnd = [IntPtr]([int64](($mainWin[0] -split '\|')[0]))
    Write-Output ("MAIN_WINDOW_ENABLED=" + [NativeDialog]::IsWindowEnabled($mainHwnd))
}

foreach ($d in $dialogs) {
    $dParts = $d -split '\|', 4
    $dHwnd = [IntPtr]([int64]$dParts[0])
    Write-Output ("DIALOG hwnd=$dHwnd title=""" + $dParts[3] + """")
    $btns = [NativeDialog]::ListChildButtons($dHwnd)
    foreach ($b in $btns) { Write-Output "  BUTTON $b" }

    if ($Action -eq "click") {
        $target = $btns | Where-Object { ($_ -split '\|', 2)[1] -eq $ButtonText }
        if (-not $target) {
            Write-Output "NO_BUTTON_MATCH"
        } else {
            $bHwnd = [IntPtr]([int64](($target[0]) -split '\|')[0])
            [NativeDialog]::SetThreadDpiAwarenessContext([NativeDialog]::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) | Out-Null
            $rect = New-Object NativeDialog+RECT
            [NativeDialog]::GetWindowRect($bHwnd, [ref]$rect) | Out-Null
            $cx = [int](($rect.Left + $rect.Right) / 2)
            $cy = [int](($rect.Top + $rect.Bottom) / 2)
            [NativeDialog]::SetForegroundWindow($dHwnd) | Out-Null
            Start-Sleep -Milliseconds 200
            [NativeDialog]::SetCursorPos($cx, $cy) | Out-Null
            Start-Sleep -Milliseconds 100
            [NativeDialog]::mouse_event([NativeDialog]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 80
            [NativeDialog]::mouse_event([NativeDialog]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
            Write-Output "CLICKED $ButtonText at ($cx,$cy)"
        }
    }
}
