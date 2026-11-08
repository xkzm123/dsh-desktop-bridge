Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Text;
public static class Q{
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}
 public delegate bool P(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] public static extern bool EnumWindows(P cb,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
}
'@
[void][Q]::SetProcessDpiAwarenessContext([IntPtr](-4))
$script:n = 0
$cb = [Q+P]{
  param($h,$l)
  if ([Q]::IsWindowVisible($h)) {
    $r = New-Object Q+RECT
    if ([Q]::GetWindowRect($h,[ref]$r)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][Q]::GetWindowTextW($h,$sb,512)
      $script:n++
    }
  }
  return $true
}
$sw = [Diagnostics.Stopwatch]::StartNew()
for ($i=0; $i -lt 5; $i++) {
  $script:n = 0
  [void][Q]::EnumWindows($cb,[IntPtr]::Zero)
  '{0} windows enumerated in {1} ms' -f $script:n, $sw.ElapsedMilliseconds
  $sw.Restart()
}
