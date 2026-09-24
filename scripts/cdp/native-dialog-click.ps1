# Clica un botón de un diálogo nativo de Windows (#32770, los que abre
# tauri-plugin-dialog) con BM_CLICK (mensaje Win32), no con un clic de ratón
# físico. Historial: en una sesión anterior pareció que solo el clic real
# funcionaba (BM_CLICK no cerraba el diálogo) — resultó ser un bug propio
# (`$target[0]` sacando el primer carácter de un string en vez del elemento
# de un array de un solo match, ver más abajo), no un problema de BM_CLICK.
# Verificado de nuevo, limpio, contra el .exe de release: BM_CLICK cierra el
# diálogo de forma fiable y el estado de git cambia como se espera para cada
# botón. Aparte: el clic físico (SetCursorPos/SendInput) funcionó de verdad
# en una pasada contra `tauri dev` y dejó de hacerlo en la siguiente contra
# el .exe — SetCursorPos/SendInput seguían devolviendo éxito, pero
# GetCursorPos después se quedaba clavado en el centro de la pantalla, sin
# causa identificada. BM_CLICK no depende de mover el cursor real — manda
# el mensaje directo al control — y fue fiable en las dos pasadas.
#
# Uso:
#   & native-dialog-click.ps1 -OwnerPid <pid> -Action find
#   & native-dialog-click.ps1 -OwnerPid <pid> -Action click -ButtonText "Cancelar"
#
# No mueve el cursor ni la ventana a primer plano — no hace falta avisar
# antes de lanzarlo.
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
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public const uint BM_CLICK = 0x00F5;

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

$allWindows = [NativeDialog]::ListVisibleTopLevel()
# @() en las dos: con un solo resultado, Where-Object devuelve un string
# suelto y [0] sacaría su primer carácter en vez del elemento (mismo bug
# que el de más abajo, con el mismo síntoma: un hwnd inválido y todo lo
# que dependa de él fallando en silencio, nunca con una excepción).
$dialogs = @($allWindows | Where-Object {
    $p = $_ -split '\|', 4
    [int]$p[1] -eq $OwnerPid -and $p[2] -eq "#32770"
})
if ($dialogs.Count -eq 0) { Write-Output "NONE"; exit 0 }

$mainWin = @($allWindows | Where-Object {
    $p = $_ -split '\|', 4
    [int]$p[1] -eq $OwnerPid -and $p[2] -eq "Tauri Window"
})
if ($mainWin.Count -gt 0) {
    $mainHwnd = [IntPtr]([int64](($mainWin[0] -split '\|')[0]))
    Write-Output ("MAIN_WINDOW_ENABLED=" + [NativeDialog]::IsWindowEnabled($mainHwnd))
}

if ($Action -eq "click" -and $dialogs.Count -gt 1) {
    # Con más de un diálogo abierto a la vez (huérfano de una sesión
    # anterior, o dos acciones destructivas encoladas), un solo botón se
    # pulsaría en TODOS — cerrar el sobrante con `find` primero y comprobar
    # que solo queda uno antes de reintentar `click`.
    Write-Output "MULTIPLE_DIALOGS: hay $($dialogs.Count) diálogos abiertos, no se pulsa nada"
    foreach ($d in $dialogs) {
        $dParts = $d -split '\|', 4
        Write-Output ("  DIALOG hwnd=" + $dParts[0])
    }
    exit 1
}

foreach ($d in $dialogs) {
    $dParts = $d -split '\|', 4
    $dHwnd = [IntPtr]([int64]$dParts[0])
    Write-Output ("DIALOG hwnd=$dHwnd title=""" + $dParts[3] + """")
    $btns = [NativeDialog]::ListChildButtons($dHwnd)
    foreach ($b in $btns) { Write-Output "  BUTTON $b" }

    if ($Action -eq "click") {
        $target = @($btns | Where-Object { ($_ -split '\|', 2)[1] -eq $ButtonText })
        if ($target.Count -eq 0) {
            Write-Output "NO_BUTTON_MATCH"
        } else {
            $bHwnd = [IntPtr]([int64](($target[0] -split '\|', 2)[0]))
            [NativeDialog]::SendMessage($bHwnd, [NativeDialog]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
            # Confirma el cierre en vez de asumirlo por el código de salida
            # del propio SendMessage (que no dice nada sobre si el diálogo
            # de verdad se cerró).
            $closed = $false
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Milliseconds 100
                if (-not [NativeDialog]::IsWindow($dHwnd)) { $closed = $true; break }
            }
            Write-Output ($(if ($closed) { "CLICKED $ButtonText -- CLOSED" } else { "CLICKED $ButtonText -- STILL_OPEN (fallo real)" }))
            if (-not $closed) { exit 1 }
        }
    }
}
