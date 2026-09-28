# Synapsez - desktop capture host.
#
# Deliberately a separate process from host.ps1. Reading the screen through UI
# Automation regularly takes most of a second, and PowerShell is single
# threaded, so sharing one process meant every frame queued behind whatever the
# assistant was doing - the mirror froze exactly when there was something worth
# watching. Split apart, capture keeps its own clock.
#
# stdout: one JSON frame per line.
# stdin:  {"cmd":"pause"} | {"cmd":"resume"} | {"cmd":"fps","value":10} | {"cmd":"quit"}

param(
  [double]$Fps = 10,
  [int]$Quality = 55,
  [int]$MaxWidth = 1280
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Drawing;
using System.Runtime.InteropServices;

public static class Fg {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO {
    public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos;
  }

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] static extern bool DrawIconEx(
    IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);

  public static string Title() {
    StringBuilder sb = new StringBuilder(300);
    GetWindowTextW(GetForegroundWindow(), sb, sb.Capacity);
    return sb.ToString();
  }

  // CopyFromScreen composites the desktop without the pointer, so a mirror
  // built on it alone shows things being clicked by nothing. Drawing the real
  // cursor back in is what makes it read as someone using the machine.
  public static void DrawCursor(Graphics g, int originX, int originY) {
    CURSORINFO info = new CURSORINFO();
    info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref info)) return;
    if (info.flags != 1 || info.hCursor == IntPtr.Zero) return; // 1 = CURSOR_SHOWING

    IntPtr hdc = g.GetHdc();
    try {
      // 0x0003 = DI_NORMAL, which honours the cursor's own transparency mask.
      DrawIconEx(hdc, info.ptScreenPos.x - originX, info.ptScreenPos.y - originY,
                 info.hCursor, 0, 0, 0, IntPtr.Zero, 0x0003);
    } finally {
      g.ReleaseHdc(hdc);
    }
  }
}
'@ -ReferencedAssemblies System.Drawing
[void][Fg]::SetProcessDPIAware()

$codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
         Where-Object { $_.MimeType -eq 'image/jpeg' }
$encoderParams = New-Object Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object Drawing.Imaging.EncoderParameter(
  [Drawing.Imaging.Encoder]::Quality, [long]$Quality)

# Bitmaps are allocated once and reused for the life of the process. Allocating
# a full-screen bitmap per frame costs more than the capture itself and gives
# the garbage collector a steady diet of large-object-heap blocks.
$screen = $null; $grabG = $null; $scaled = $null; $scaleG = $null
$grabW = 0; $grabH = 0

function Reset-Buffers([int]$w, [int]$h) {
  if ($script:grabW -eq $w -and $script:grabH -eq $h -and $script:screen) { return }
  if ($script:grabG) { $script:grabG.Dispose() }
  if ($script:screen) { $script:screen.Dispose() }
  if ($script:scaleG) { $script:scaleG.Dispose() }
  if ($script:scaled) { $script:scaled.Dispose() }

  $script:screen = New-Object Drawing.Bitmap($w, $h)
  $script:grabG = [Drawing.Graphics]::FromImage($script:screen)
  $script:grabW = $w; $script:grabH = $h

  $outW = $w; $outH = $h
  if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
    $outW = $MaxWidth
    $outH = [Math]::Max(1, [int]($h * ($MaxWidth / [double]$w)))
  }
  $script:scaled = New-Object Drawing.Bitmap($outW, $outH)
  $script:scaleG = [Drawing.Graphics]::FromImage($script:scaled)
  $script:scaleG.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::Bilinear
  $script:scaleG.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighSpeed
}

# A cheap fingerprint of the pixels, sampled rather than hashed in full: a
# static screen should cost nothing to notice. Sampling every 997th byte - a
# prime, so it never lines up with the row stride and misses a whole column -
# catches any change a person could see.
#
# MD5 rather than a hand-rolled hash because PowerShell throws on unsigned
# integer overflow instead of wrapping, which quietly killed every frame.
$script:Hasher = [Security.Cryptography.MD5]::Create()
$script:PixelBuffer = $null
$script:SampleBuffer = $null

function Get-Fingerprint($bitmap) {
  $rect = New-Object Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)
  $data = $bitmap.LockBits($rect, [Drawing.Imaging.ImageLockMode]::ReadOnly,
                           [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $length = [Math]::Abs($data.Stride) * $bitmap.Height
    $step = 997

    # Held between frames. A full-screen grab is several megabytes and this runs
    # ten times a second, so allocating fresh each time hands the large object
    # heap more work than the capture itself.
    if ($null -eq $script:PixelBuffer -or $script:PixelBuffer.Length -lt $length) {
      $script:PixelBuffer = New-Object byte[] $length
      $script:SampleBuffer = New-Object byte[] ([Math]::Max(1, [int][Math]::Ceiling($length / $step)))
    }

    [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $script:PixelBuffer, 0, $length)
    $n = 0
    for ($i = 0; $i -lt $length; $i += $step) { $script:SampleBuffer[$n] = $script:PixelBuffer[$i]; $n++ }
    return [Convert]::ToBase64String($script:Hasher.ComputeHash($script:SampleBuffer))
  } finally {
    $bitmap.UnlockBits($data)
  }
}

# Not [Console]::In: that is a *synchronized* TextReader whose ReadLineAsync
# blocks the calling thread despite the name, which stalls the capture loop on
# the very first iteration waiting for a command that may never come. A
# StreamReader over the raw handle is asynchronous for real.
$stdin = New-Object IO.StreamReader(
  [Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding($false)))
$pendingRead = $stdin.ReadLineAsync()
$paused = $false
$lastPrint = ''
$lastSentAt = [DateTime]::MinValue
$lastComplaint = ''

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  # Non-blocking command check: a blocking ReadLine here would stall the whole
  # capture loop waiting for a message that may never come.
  if ($pendingRead.IsCompleted) {
    $line = $pendingRead.Result
    if ($null -eq $line) { break }
    $pendingRead = $stdin.ReadLineAsync()
    if ($line.Trim()) {
      try {
        $msg = $line | ConvertFrom-Json
        switch ($msg.cmd) {
          'pause'  { $paused = $true }
          'resume' { $paused = $false; $lastPrint = '' }
          'fps'    { $Fps = [Math]::Min([Math]::Max([double]$msg.value, 0.2), 20) }
          'quit'   { exit 0 }
        }
      } catch { }
    }
  }

  if ($paused) { Start-Sleep -Milliseconds 120; continue }

  $frameStart = [DateTime]::UtcNow
  try {
    $v = [Windows.Forms.SystemInformation]::VirtualScreen
    Reset-Buffers $v.Width $v.Height
    $grabG.CopyFromScreen($v.Left, $v.Top, 0, 0, (New-Object Drawing.Size($v.Width, $v.Height)))
    [Fg]::DrawCursor($grabG, $v.Left, $v.Top)

    # Fingerprinting after the cursor is drawn means pointer movement counts as
    # a change, which is what someone watching would expect.
    $print = Get-Fingerprint $screen
    # Resend an unchanged screen every two seconds anyway, so a viewer who
    # arrives mid-idle is not staring at nothing.
    $stale = ([DateTime]::UtcNow - $lastSentAt).TotalSeconds -ge 2
    if ($print -ne $lastPrint -or $stale) {
      $lastPrint = $print
      $lastSentAt = [DateTime]::UtcNow

      if ($scaled.Width -ne $screen.Width) {
        $scaleG.DrawImage($screen, 0, 0, $scaled.Width, $scaled.Height)
        $image = $scaled
      } else {
        $image = $screen
      }

      $stream = New-Object IO.MemoryStream
      $image.Save($stream, $codec, $encoderParams)
      $payload = @{
        frame = [Convert]::ToBase64String($stream.ToArray())
        width = $image.Width
        height = $image.Height
        title = [Fg]::Title()
      }
      $stream.Dispose()
      [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    }
  } catch {
    # A capture can fail transiently - a UAC prompt owns the desktop, the
    # session locks. Neither is a reason to give up streaming. But say so once
    # per distinct fault: swallowing these silently is how a camera that never
    # emitted a single frame looked exactly like a camera with nothing to show.
    $complaint = "$($_.Exception.Message)"
    if ($complaint -ne $lastComplaint) {
      $lastComplaint = $complaint
      [Console]::Error.WriteLine("capture: $complaint")
    }
    Start-Sleep -Milliseconds 500
  }

  $spent = ([DateTime]::UtcNow - $frameStart).TotalMilliseconds
  $budget = 1000.0 / $Fps
  if ($spent -lt $budget) { Start-Sleep -Milliseconds ([int]($budget - $spent)) }
}
