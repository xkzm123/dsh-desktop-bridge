# dsh-windows-mcp fastpath host
#
# A long-lived, DPI-correct Win32 sidecar for the ops that made the Windows-MCP
# bridge slow or wrong during real game automation:
#
#   * Snapshot (whole-desktop UIA walk)            ~26 000 ms  -> windows/rect   ~60 ms
#   * no window rect in Click's coordinate space   misclicks   -> rect in physical virtual-desktop px
#   * no launch primitive (App tool excluded)      6 pwsh calls -> launch + wait-for-window
#   * 10 s USER_CONTROL gate on every call         0-20 s       -> no gate, direct SendInput
#   * verify-by-screenshot                         ~4 s/step    -> pixel / wait / click echo
#
# Protocol: one JSON object per line on stdin, one JSON object per line on
# stdout. Every reply carries the same `id` and a `ms` duration so the host half
# can report real timings instead of guesses.
#
# Ops
#   ping
#   windows            [filter]                      visible top-level windows + physical rects
#   focus              hwnd|title                    activate, return rect + foreground
#   launch             path [args] [waitMs] [title]  start, wait for its window, return rect
#   click              x y [button] [clicks] [hwnd]  optional focus, then SendInput at absolute coords
#   move               x y
#   key                combo                         "ENTER", "F5", "ctrl+shift+s"
#   type               text                          unicode SendInput
#   pixel              x y                           "#rrggbb"
#   wait               window|pixel|idle             cheap predicate loop, no model round trip
#   rect               hwnd                          rect of one window
#   kill               hwnd|pid

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# The channel is UTF-8 in both directions: Chinese window titles are the norm on
# this machine, and PowerShell defaults to the ANSI code page for stdio.
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class FP
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint id);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr unused);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetFocus();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);

    public static bool MakePerMonitorV2()
    {
        try { return SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { return false; }
    }

    public static string Title(IntPtr h)
    {
        var sb = new StringBuilder(1024);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string Class(IntPtr h)
    {
        var sb = new StringBuilder(256);
        GetClassNameW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static uint Pid(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return pid;
    }

    static void AltTap()
    {
        // A synthetic ALT tap makes this thread the last-input thread, which is
        // exactly what unlocks SetForegroundWindow for a background process.
        Key(0x12, false);
        Key(0x12, true);
        System.Threading.Thread.Sleep(30);
    }

    public static bool Focus(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        if (IsIconic(h)) ShowWindow(h, 9);
        // Deliberately NO AttachThreadInput: attaching to the current foreground
        // thread and detaching afterwards hands activation straight back to the
        // window that was in front before (measured: the game lost the foreground
        // again ~500 ms after a successful SetForegroundWindow, and every later
        // click landed in Edge).
        //
        // Two documented-ish steps are enough:
        //   1. an ALT tap makes this thread the last-input thread, which unlocks
        //      SetForegroundWindow for a background process;
        //   2. a topmost round-trip lifts the window above whatever normal-band
        //      window currently covers it.
        AltTap();
        SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002); // HWND_TOPMOST
        SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002); // HWND_NOTOPMOST
        BringWindowToTop(h);
        SetForegroundWindow(h);
        SetFocus(h);
        System.Threading.Thread.Sleep(70);
        if (GetForegroundWindow() == h) return true;
        // Retries: keep the window topmost, then the legacy SwitchToThisWindow,
        // which still activates windows that refuse SetForegroundWindow.
        for (int attempt = 0; attempt < 2; attempt++)
        {
            AltTap();
            SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002);
            SetForegroundWindow(h);
            System.Threading.Thread.Sleep(60);
            if (GetForegroundWindow() == h) return true;
            SwitchToThisWindow(h, false);
            System.Threading.Thread.Sleep(60);
            if (GetForegroundWindow() == h) return true;
        }
        return GetForegroundWindow() == h;
    }

    public static void Unpin(IntPtr h)
    {
        if (h == IntPtr.Zero) return;
        SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002);
    }

    static void Mouse(uint flags, int x, int y)
    {
        var input = new INPUT();
        input.type = 0; // INPUT_MOUSE
        input.mi.dx = x;
        input.mi.dy = y;
        input.mi.dwFlags = flags;
        var one = new INPUT[1];
        one[0] = input;
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Normalized(int x, int y, out int nx, out int ny)
    {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
        int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        nx = (int)((long)(x - vx) * 65535 / Math.Max(1, vw - 1));
        ny = (int)((long)(y - vy) * 65535 / Math.Max(1, vh - 1));
    }

    public static void MoveAbsolute(int x, int y)
    {
        int nx, ny;
        Normalized(x, y, out nx, out ny);
        Mouse(0x8001 | 0x4000, nx, ny); // MOVE | ABSOLUTE | VIRTUALDESK
    }

    public static void Button(uint down, uint up, int x, int y)
    {
        int nx, ny;
        Normalized(x, y, out nx, out ny);
        // Every event carries the coordinate. A down/up with ABSOLUTE and dx=dy=0
        // normalizes to the virtual-screen origin, so the press landed in the
        // top-left corner while GetCursorPos still reported the intended point.
        Mouse(0x8001 | 0x4000, nx, ny);
        System.Threading.Thread.Sleep(30);
        Mouse(down | 0x8000 | 0x4000, nx, ny);
        System.Threading.Thread.Sleep(45);
        Mouse(up | 0x8000 | 0x4000, nx, ny);
    }

    public static void Key(ushort vk, bool up)
    {
        var input = new INPUT();
        input.type = 1; // INPUT_KEYBOARD
        input.ki.wVk = vk;
        input.ki.dwFlags = up ? 0x0002u : 0u;
        var one = new INPUT[1];
        one[0] = input;
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Unicode(char ch, bool up)
    {
        var input = new INPUT();
        input.type = 1;
        input.ki.wScan = ch;
        input.ki.dwFlags = 0x0004u | (up ? 0x0002u : 0u);
        var one = new INPUT[1];
        one[0] = input;
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@

[void][FP]::MakePerMonitorV2()

function Get-VirtualScreen {
    $x = [FP]::GetSystemMetrics(76); $y = [FP]::GetSystemMetrics(77)
    $w = [FP]::GetSystemMetrics(78); $h = [FP]::GetSystemMetrics(79)
    [pscustomobject]@{ x = $x; y = $y; w = $w; h = $h }
}

function Get-WindowRow {
    param([IntPtr]$Hwnd)
    $r = New-Object FP+RECT
    if (-not [FP]::GetWindowRect($Hwnd, [ref]$r)) { return $null }
    [pscustomobject]@{
        hwnd      = [int64]$Hwnd
        title     = [FP]::Title($Hwnd)
        class     = [FP]::Class($Hwnd)
        pid       = [FP]::Pid($Hwnd)
        x         = $r.Left
        y         = $r.Top
        w         = $r.Right - $r.Left
        h         = $r.Bottom - $r.Top
        minimized = [bool][FP]::IsIconic($Hwnd)
        visible   = [bool][FP]::IsWindowVisible($Hwnd)
    }
}

function Get-Windows {
    param([string]$Filter = '')
    $script:fpRows = New-Object System.Collections.ArrayList
    $cb = [FP+EnumProc]{
        param([IntPtr]$h, [IntPtr]$l)
        try {
            if (-not [FP]::IsWindowVisible($h)) { return $true }
            $r = New-Object FP+RECT
            if (-not [FP]::GetWindowRect($h, [ref]$r)) { return $true }
            if (($r.Right - $r.Left) -le 1 -or ($r.Bottom - $r.Top) -le 1) { return $true }
            $title = [FP]::Title($h)
            $class = [FP]::Class($h)
            if ($Filter -ne '' -and ("$title $class" -notmatch $Filter)) { return $true }
            $null = $script:fpRows.Add([pscustomobject]@{
                hwnd      = [int64]$h
                title     = $title
                class     = $class
                pid       = [FP]::Pid($h)
                x         = $r.Left
                y         = $r.Top
                w         = $r.Right - $r.Left
                h         = $r.Bottom - $r.Top
                minimized = [bool][FP]::IsIconic($h)
            })
        } catch { }
        return $true
    }
    [void][FP]::EnumWindows($cb, [IntPtr]::Zero)
    return @($script:fpRows)
}

function Resolve-Window {
    param($Hwnd, [string]$Title)
    if ($Hwnd) { return [IntPtr][int64]$Hwnd }
    if ($Title -ne '' -and $Title -ne $null) {
        $hit = Get-Windows -Filter $Title | Where-Object { $_.title -match $Title } | Select-Object -First 1
        if ($hit) { return [IntPtr][int64]$hit.hwnd }
    }
    return [IntPtr]::Zero
}

function Invoke-Op {
    param($req)
    $op = [string]$req.op
    switch ($op) {
        'ping' {
            $vs = Get-VirtualScreen
            return [pscustomobject]@{ ok = $true; virtualScreen = $vs; dpiAware = $true; foreground = [int64][FP]::GetForegroundWindow() }
        }
        'windows' {
            $rows = Get-Windows -Filter ([string]$req.filter)
            return [pscustomobject]@{ ok = $true; count = @($rows).Count; windows = @($rows) }
        }
        'rect' {
            $h = Resolve-Window -Hwnd $req.hwnd -Title ([string]$req.title)
            if ($h -eq [IntPtr]::Zero) { return [pscustomobject]@{ ok = $false; error = 'window not found' } }
            return [pscustomobject]@{ ok = $true; window = (Get-WindowRow -Hwnd $h) }
        }
        'focus' {
            $h = Resolve-Window -Hwnd $req.hwnd -Title ([string]$req.title)
            if ($h -eq [IntPtr]::Zero) { return [pscustomobject]@{ ok = $false; error = 'window not found' } }
            $okFocus = [FP]::Focus($h)
            Start-Sleep -Milliseconds 80
            $row = Get-WindowRow -Hwnd $h
            if (-not $okFocus -or $null -eq $row) {
                return [pscustomobject]@{ ok = $false; error = 'window vanished or refused activation'; window = $row; foreground = [int64][FP]::GetForegroundWindow(); focusOk = $okFocus }
            }
            return [pscustomobject]@{ ok = $true; window = $row; foreground = [int64][FP]::GetForegroundWindow(); focusOk = $okFocus }
        }
        'launch' {
            $path = [string]$req.path
            if (-not (Test-Path -LiteralPath $path)) { return [pscustomobject]@{ ok = $false; error = "not found: $path" } }
            $argList = @()
            if ($req.args) { $argList = @($req.args | ForEach-Object { [string]$_ }) }
            $sw = [Diagnostics.Stopwatch]::StartNew()
            # Remember every window that already exists. A stale window with the
            # same title (an earlier run of the same app, or a leftover launcher)
            # must never satisfy the wait, or the caller focuses the wrong process
            # and every following click lands in a dead window.
            $baseline = @{}
            foreach ($w in (Get-Windows)) { $baseline[[int64]$w.hwnd] = $true }
            $p = if ($argList.Count -gt 0) { Start-Process -FilePath $path -ArgumentList $argList -PassThru } else { Start-Process -FilePath $path -PassThru }
            $waitMs = if ($req.waitMs) { [int]$req.waitMs } else { 20000 }
            $want = [string]$req.title
            # Poll for a NEW window that stays put. Re-resolving on every pass
            # (instead of latching the first handle) is what survives the SDL
            # dance: the app creates an 806x629 frame with the real title, throws
            # it away ~300 ms later and builds the 406x529 launcher.
            $row = $null
            $lastSig = $null
            $stable = 0
            while ($sw.ElapsedMilliseconds -lt $waitMs) {
                Start-Sleep -Milliseconds 110
                $p.Refresh()
                if ($p.HasExited) {
                    return [pscustomobject]@{ ok = $false; error = 'process exited before a window appeared'; exitCode = $p.ExitCode; elapsedMs = $sw.ElapsedMilliseconds; pid = $p.Id }
                }
                $cur = Get-Windows |
                    Where-Object {
                        $_.title -ne '' -and
                        -not $baseline.ContainsKey([int64]$_.hwnd) -and
                        ($_.pid -eq $p.Id -or ($want -ne '' -and $_.title -match $want))
                    } |
                    Select-Object -First 1
                if ($null -eq $cur) { $stable = 0; $lastSig = $null; continue }
                $sig = "$($cur.hwnd)|$($cur.x)|$($cur.y)|$($cur.w)|$($cur.h)"
                if ($sig -eq $lastSig) { $stable++ } else { $stable = 0; $lastSig = $sig }
                $row = $cur
                if ($stable -ge 3) { break }
            }
            $sw.Stop()
            if (-not $row) { return [pscustomobject]@{ ok = $false; error = 'no window within waitMs'; elapsedMs = $sw.ElapsedMilliseconds; pid = $p.Id } }
            return [pscustomobject]@{ ok = $true; pid = $p.Id; elapsedMs = $sw.ElapsedMilliseconds; window = $row }
        }
        'click' {
            $h = [IntPtr]::Zero
            if ($req.hwnd -or $req.title) { $h = Resolve-Window -Hwnd $req.hwnd -Title ([string]$req.title) }
            $focusOk = $null
            if ($h -ne [IntPtr]::Zero) { $focusOk = [FP]::Focus($h); Start-Sleep -Milliseconds 60 }
            $x = [int]$req.x; $y = [int]$req.y
            $button = if ($req.button) { [string]$req.button } else { 'left' }
            $clicks = if ($req.clicks) { [int]$req.clicks } else { 1 }
            switch ($button) {
                'right' { $down = 0x0008; $up = 0x0010 }
                'middle' { $down = 0x0020; $up = 0x0040 }
                default { $down = 0x0002; $up = 0x0004 }
            }
            for ($i = 0; $i -lt $clicks; $i++) {
                [FP]::Button([uint32]$down, [uint32]$up, $x, $y)
                if ($i -lt $clicks - 1) { Start-Sleep -Milliseconds 70 }
            }
            $pt = New-Object FP+POINT
            [void][FP]::GetCursorPos([ref]$pt)
            $fgNow = [int64][FP]::GetForegroundWindow()
            if ($h -ne [IntPtr]::Zero -and $fgNow -ne [int64]$h) {
                # Clicking anyway would land in whatever window is actually in
                # front (measured: Edge), so report the miss instead of pretending.
                return [pscustomobject]@{ ok = $false; error = "window did not reach the foreground (fg=$fgNow want=$([int64]$h))"; clicked = @($x, $y); foreground = $fgNow; focused = [int64]$h }
            }
            return [pscustomobject]@{ ok = $true; clicked = @($x, $y); cursor = @($pt.X, $pt.Y); foreground = $fgNow; focused = [int64]$h; focusOk = $focusOk }
        }
        'move' {
            [FP]::MoveAbsolute([int]$req.x, [int]$req.y)
            return [pscustomobject]@{ ok = $true; cursor = @([int]$req.x, [int]$req.y) }
        }
        'key' {
            $combo = [string]$req.combo
            $vkMap = @{
                'ENTER' = 0x0D; 'ESC' = 0x1B; 'ESCAPE' = 0x1B; 'TAB' = 0x09; 'SPACE' = 0x20
                'BACKSPACE' = 0x08; 'DELETE' = 0x2E; 'UP' = 0x26; 'DOWN' = 0x28; 'LEFT' = 0x25; 'RIGHT' = 0x27
                'HOME' = 0x24; 'END' = 0x23; 'PAGEUP' = 0x21; 'PAGEDOWN' = 0x22
                'CTRL' = 0x11; 'CONTROL' = 0x11; 'SHIFT' = 0x10; 'ALT' = 0x12; 'WIN' = 0x5B
                'F1' = 0x70; 'F2' = 0x71; 'F3' = 0x72; 'F4' = 0x73; 'F5' = 0x74; 'F6' = 0x75
                'F7' = 0x76; 'F8' = 0x77; 'F9' = 0x78; 'F10' = 0x79; 'F11' = 0x7A; 'F12' = 0x7B
            }
            $parts = $combo.Split('+') | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ -ne '' }
            $vks = @()
            foreach ($p in $parts) {
                if ($vkMap.ContainsKey($p)) { $vks += $vkMap[$p] }
                elseif ($p.Length -eq 1) { $vks += [int][char]$p }
                else { return [pscustomobject]@{ ok = $false; error = "unknown key: $p" } }
            }
            foreach ($vk in $vks) { [FP]::Key([uint16]$vk, $false); Start-Sleep -Milliseconds 25 }
            foreach ($vk in ($vks | Select-Object -Reverse)) { [FP]::Key([uint16]$vk, $true); Start-Sleep -Milliseconds 20 }
            return [pscustomobject]@{ ok = $true; combo = $combo }
        }
        'type' {
            $text = [string]$req.text
            foreach ($ch in $text.ToCharArray()) {
                [FP]::Unicode($ch, $false); [FP]::Unicode($ch, $true)
                Start-Sleep -Milliseconds 8
            }
            return [pscustomobject]@{ ok = $true; length = $text.Length }
        }
        'pixel' {
            $x = [int]$req.x; $y = [int]$req.y
            $bmp = New-Object System.Drawing.Bitmap 1, 1
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size 1, 1))
            $c = $bmp.GetPixel(0, 0)
            $g.Dispose(); $bmp.Dispose()
            return [pscustomobject]@{ ok = $true; x = $x; y = $y; hex = ('#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B) }
        }
        'wait' {
            $mode = if ($req.mode) { [string]$req.mode } else { 'window' }
            $timeout = if ($req.timeoutMs) { [int]$req.timeoutMs } else { 10000 }
            $stableMs = if ($req.stableMs) { [int]$req.stableMs } else { 0 }
            $stableHwnd = $null
            $stableSince = $null
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $last = $null
            while ($sw.ElapsedMilliseconds -lt $timeout) {
                switch ($mode) {
                    'window' {
                        $want = [string]$req.title
                        $hit = Get-Windows -Filter $want | Where-Object { $_.title -match $want } | Select-Object -First 1
                        if ($hit) { $sw.Stop(); return [pscustomobject]@{ ok = $true; mode = $mode; elapsedMs = $sw.ElapsedMilliseconds; window = $hit } }
                    }
                    'window_size' {
                        # A launcher that restarts its own process shows the small
                        # config window first and the fullscreen surface a moment
                        # later; waiting on the size is what makes the next click
                        # land on the game instead of on a window that is about to
                        # be replaced.
                        $want = [string]$req.title
                        $minW = if ($req.minWidth) { [int]$req.minWidth } else { 1 }
                        $minH = if ($req.minHeight) { [int]$req.minHeight } else { 1 }
                        $hit = Get-Windows -Filter $want |
                            Where-Object { $_.title -match $want -and $_.w -ge $minW -and $_.h -ge $minH } |
                            Select-Object -First 1
                        if ($hit) {
                            if ($stableMs -le 0) { $sw.Stop(); return [pscustomobject]@{ ok = $true; mode = $mode; elapsedMs = $sw.ElapsedMilliseconds; window = $hit } }
                            # A launcher that restarts its own process tears the
                            # window down and builds a new one; the handle must
                            # survive long enough to be worth focusing.
                            if ($stableHwnd -ne [int64]$hit.hwnd) {
                                $stableHwnd = [int64]$hit.hwnd
                                $stableSince = [Diagnostics.Stopwatch]::StartNew()
                            } elseif ($stableSince.ElapsedMilliseconds -ge $stableMs) {
                                $sw.Stop()
                                return [pscustomobject]@{ ok = $true; mode = $mode; elapsedMs = $sw.ElapsedMilliseconds; window = $hit; stableMs = $stableSince.ElapsedMilliseconds }
                            }
                        } else {
                            $stableHwnd = $null
                        }
                    }
                    'pixel' {
                        $bmp = New-Object System.Drawing.Bitmap 1, 1
                        $g = [System.Drawing.Graphics]::FromImage($bmp)
                        $g.CopyFromScreen([int]$req.x, [int]$req.y, 0, 0, (New-Object System.Drawing.Size 1, 1))
                        $c = $bmp.GetPixel(0, 0)
                        $g.Dispose(); $bmp.Dispose()
                        $hex = ('#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B)
                        if ($hex -eq [string]$req.hex) { $sw.Stop(); return [pscustomobject]@{ ok = $true; mode = $mode; elapsedMs = $sw.ElapsedMilliseconds; hex = $hex } }
                        $last = $hex
                    }
                    'idle' {
                        $x = [int]$req.x; $y = [int]$req.y; $w = [int]$req.w; $h = [int]$req.h
                        $bmp = New-Object System.Drawing.Bitmap ([Math]::Max(1, $w)), ([Math]::Max(1, $h))
                        $g = [System.Drawing.Graphics]::FromImage($bmp)
                        $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size ([Math]::Max(1, $w)), ([Math]::Max(1, $h))))
                        $sum = 0L
                        for ($i = 0; $i -lt $bmp.Width; $i += 16) { for ($j = 0; $j -lt $bmp.Height; $j += 16) { $sum += $bmp.GetPixel($i, $j).ToArgb() } }
                        $g.Dispose(); $bmp.Dispose()
                        if ($null -eq $script:lastSum) { $script:lastSum = $sum }
                        elseif ($sum -eq $script:lastSum) { $sw.Stop(); return [pscustomobject]@{ ok = $true; mode = $mode; elapsedMs = $sw.ElapsedMilliseconds; sum = $sum } }
                        else { $script:lastSum = $sum }
                    }
                }
                Start-Sleep -Milliseconds 80
            }
            $sw.Stop()
            return [pscustomobject]@{ ok = $false; mode = $mode; elapsedMs = $sw.ElapsedMilliseconds; last = $last; error = 'timeout' }
        }
        'kill' {
            if ($req.pid) { Stop-Process -Id ([int]$req.pid) -Force; return [pscustomobject]@{ ok = $true; killed = [int]$req.pid } }
            if ($req.hwnd) { $r = Get-WindowRow -Hwnd ([IntPtr][int64]$req.hwnd); if ($r) { Stop-Process -Id ([int]$r.pid) -Force; return [pscustomobject]@{ ok = $true; killed = [int]$r.pid } } }
            return [pscustomobject]@{ ok = $false; error = 'pid or hwnd required' }
        }
        default { return [pscustomobject]@{ ok = $false; error = "unknown op: $op" } }
    }
}

# [Console]::Out has no settable AutoFlush in PowerShell (5.1 or 7); the writer
# is flushed explicitly after every reply instead.
$stdout = [Console]::Out
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $result = Invoke-Op $req
    } catch {
        $result = [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
    }
    $sw.Stop()
    $payload = [pscustomobject]@{ id = $id; ms = $sw.ElapsedMilliseconds; result = $result }
    $stdout.WriteLine(($payload | ConvertTo-Json -Depth 8 -Compress))
    $stdout.Flush()
}
