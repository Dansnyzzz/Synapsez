# Synapsez - Windows desktop host.
#
# A long-lived PowerShell process that the worker talks to over stdin/stdout in
# JSON lines. It exists because the alternative - spawning powershell.exe per
# action - costs ~700ms of assembly loading every single time, which turns a
# ten-step task into a ten-second one.
#
# Everything here is built on what Windows already ships with: UI Automation for
# reading the screen, SendInput for driving it, System.Drawing for capturing it.
# There is no native module to compile and nothing to install.
#
# Protocol, one JSON object per line:
#   in   {"id":1,"cmd":"windows","args":{}}
#   out  {"id":1,"ok":true,"result":{...}}   or   {"id":1,"ok":false,"error":"..."}

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Window titles are routinely non-ASCII - the user's own machine has Vietnamese
# ones. Without this they arrive as mojibake and every title match fails.
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing

Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData;
    public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags;
    public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type; public INPUTUNION u;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT {
    public int Left, Top, Right, Bottom;
  }

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004;
  const uint RDOWN = 0x0008, RUP = 0x0010, WHEEL = 0x0800;
  const uint ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
  const uint KEYUP = 0x0002, UNICODE = 0x0004;

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);

  delegate bool EnumProc(IntPtr h, IntPtr param);

  static int VX { get { return System.Windows.Forms.SystemInformation.VirtualScreen.Left; } }
  static int VY { get { return System.Windows.Forms.SystemInformation.VirtualScreen.Top; } }
  static int VW { get { return System.Windows.Forms.SystemInformation.VirtualScreen.Width; } }
  static int VH { get { return System.Windows.Forms.SystemInformation.VirtualScreen.Height; } }

  // Absolute mouse coordinates are a 0..65535 range spanning the whole virtual
  // desktop, not pixels - so a second monitor left of the primary (negative
  // pixel X) still maps correctly.
  static INPUT MouseAt(int x, int y, uint flags, uint data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dx = (int)(((double)(x - VX) / VW) * 65535.0);
    i.u.mi.dy = (int)(((double)(y - VY) / VH) * 65535.0);
    i.u.mi.mouseData = data;
    i.u.mi.dwFlags = flags | ABSOLUTE | VIRTUALDESK;
    return i;
  }

  public static void MoveTo(int x, int y) {
    SendInput(1, new INPUT[] { MouseAt(x, y, MOVE, 0) }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Click(int x, int y, bool right, int times) {
    uint down = right ? RDOWN : LDOWN, up = right ? RUP : LUP;
    List<INPUT> seq = new List<INPUT>();
    seq.Add(MouseAt(x, y, MOVE, 0));
    for (int n = 0; n < times; n++) {
      seq.Add(MouseAt(x, y, down, 0));
      seq.Add(MouseAt(x, y, up, 0));
    }
    SendInput((uint)seq.Count, seq.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Scroll(int x, int y, int notches) {
    SendInput(1, new INPUT[] { MouseAt(x, y, WHEEL, unchecked((uint)(notches * 120))) },
              Marshal.SizeOf(typeof(INPUT)));
  }

  // Typing as Unicode scan codes rather than virtual keys, so accented and
  // non-Latin characters arrive exactly as written regardless of the active
  // keyboard layout.
  public static void TypeUnicode(string text) {
    List<INPUT> seq = new List<INPUT>();
    foreach (char c in text) {
      for (int updown = 0; updown < 2; updown++) {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wScan = c;
        i.u.ki.dwFlags = UNICODE | (updown == 1 ? KEYUP : 0);
        seq.Add(i);
      }
      if (seq.Count >= 200) {
        SendInput((uint)seq.Count, seq.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        seq.Clear();
      }
    }
    if (seq.Count > 0)
      SendInput((uint)seq.Count, seq.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  public static void KeyStroke(ushort[] vks) {
    List<INPUT> seq = new List<INPUT>();
    foreach (ushort vk in vks) {
      INPUT d = new INPUT(); d.type = INPUT_KEYBOARD; d.u.ki.wVk = vk; seq.Add(d);
    }
    for (int n = vks.Length - 1; n >= 0; n--) {
      INPUT u = new INPUT(); u.type = INPUT_KEYBOARD; u.u.ki.wVk = vks[n]; u.u.ki.dwFlags = KEYUP;
      seq.Add(u);
    }
    SendInput((uint)seq.Count, seq.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  // Windows refuses SetForegroundWindow from a process that is not already in
  // front. Briefly sharing an input queue with the target's thread lifts that,
  // which is the documented way to do this and what every automation tool does.
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    uint ownerPid;
    uint target = GetWindowThreadProcessId(h, out ownerPid);
    uint self = GetCurrentThreadId();
    if (target == self) return SetForegroundWindow(h);
    AttachThreadInput(self, target, true);
    bool ok = SetForegroundWindow(h);
    AttachThreadInput(self, target, false);
    return ok;
  }

  public static void CloseWindow(IntPtr h) {
    PostMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
  }

  public class Win {
    public long Handle; public string Title; public int Pid;
    public int X; public int Y; public int Width; public int Height;
    public bool Minimized; public bool Foreground;
  }

  public static List<Win> ListWindows() {
    List<Win> found = new List<Win>();
    IntPtr front = GetForegroundWindow();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      StringBuilder sb = new StringBuilder(len + 2);
      GetWindowTextW(h, sb, sb.Capacity);
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      // Tool windows and off-screen shells report degenerate rectangles.
      if (r.Right - r.Left < 40 || r.Bottom - r.Top < 40) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      Win w = new Win();
      w.Handle = h.ToInt64(); w.Title = sb.ToString(); w.Pid = (int)pid;
      w.X = r.Left; w.Y = r.Top; w.Width = r.Right - r.Left; w.Height = r.Bottom - r.Top;
      w.Minimized = IsIconic(h); w.Foreground = (h == front);
      found.Add(w);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

# Without this, every coordinate we read and every coordinate we click is scaled
# by the display's DPI factor and lands in the wrong place on a high-DPI screen.
[void][Native]::SetProcessDPIAware()

$UIA = [Windows.Automation.AutomationElement]
$script:Refs = @{}          # ref number -> AutomationElement, from the last snapshot
$script:RefBoxes = @{}      # ref number -> screen rectangle, for the click fallback
$script:RefWindow = 0       # which window those numbers describe
$script:RefTitle = ''

# -- helpers -----------------------------------------------------------

function Get-WindowByHandle([long]$handle) {
  foreach ($w in [Native]::ListWindows()) { if ($w.Handle -eq $handle) { return $w } }
  return $null
}

# Match on a fragment, case-insensitively, because a model asked to focus
# "Notepad" should not have to reproduce "Untitled - Notepad" exactly.
function Resolve-Window($spec) {
  $all = [Native]::ListWindows()
  if ($null -eq $spec -or "$spec" -eq '') {
    $front = $all | Where-Object { $_.Foreground } | Select-Object -First 1
    if ($front) { return $front }
    return $all | Select-Object -First 1
  }
  $text = "$spec"
  $exact = $all | Where-Object { $_.Title -eq $text } | Select-Object -First 1
  if ($exact) { return $exact }
  $partial = $all | Where-Object { $_.Title -and $_.Title.ToLower().Contains($text.ToLower()) } |
             Select-Object -First 1
  if ($partial) { return $partial }
  if ($text -match '^\d+$') {
    $byHandle = Get-WindowByHandle ([long]$text)
    if ($byHandle) { return $byHandle }
  }
  return $null
}

# Control types a person could actually act on. Everything else becomes context
# text rather than a numbered target, which keeps the list short enough to read.
$script:Actionable = @(
  'Button','Edit','ComboBox','CheckBox','RadioButton','MenuItem','TabItem',
  'ListItem','TreeItem','Hyperlink','SplitButton','Slider','Document','Spinner','Custom'
)

function Get-Snapshot($window, [int]$limit = 140) {
  $script:Refs = @{}
  $script:RefBoxes = @{}
  $script:RefWindow = $window.Handle
  $script:RefTitle = $window.Title

  $root = $UIA::FromHandle([IntPtr]$window.Handle)
  if ($null -eq $root) { throw "That window could not be inspected." }

  $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $elements = New-Object Collections.ArrayList
  $texts = New-Object Collections.ArrayList
  $index = 0

  # Breadth-first so the numbering follows what is visually prominent, and
  # bounded by both count and time - a rich app like Explorer has thousands of
  # descendants and walking them all would stall the whole agent.
  $queue = New-Object Collections.Generic.Queue[object]
  $queue.Enqueue(@{ el = $root; depth = 0 })

  while ($queue.Count -gt 0) {
    if ($index -ge $limit -or $timer.ElapsedMilliseconds -gt 4000) { break }
    $node = $queue.Dequeue()
    $el = $node.el

    try {
      $cur = $el.Current
      $type = $cur.ControlType.ProgrammaticName -replace 'ControlType\.', ''
      $name = $cur.Name
      $box = $cur.BoundingRectangle

      $visible = -not $cur.IsOffscreen -and $box.Width -ge 3 -and $box.Height -ge 3

      if ($visible -and $node.depth -gt 0) {
        if ($script:Actionable -contains $type -and ($name -or $type -eq 'Edit')) {
          $index++
          $script:Refs[$index] = $el
          $script:RefBoxes[$index] = @{
            x = [int]($box.X + $box.Width / 2); y = [int]($box.Y + $box.Height / 2)
          }
          $value = ''
          try {
            $vp = $null
            if ($el.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
              $value = $vp.Current.Value
            }
          } catch { }
          $label = if ($name) { $name } else { $value }
          if ($value -and $name -and $value -ne $name) { $label = "$name = $value" }
          [void]$elements.Add(@{
            ref = $index
            type = $type
            label = if ($label) { $label.Substring(0, [Math]::Min(90, $label.Length)) } else { '' }
            enabled = $cur.IsEnabled
          })
        } elseif ($type -eq 'Text' -and $name -and $name.Trim()) {
          if ($texts.Count -lt 120) { [void]$texts.Add($name.Trim()) }
        }
      }

      # Descend even through elements that look invisible. XAML apps -
      # Calculator, Settings, anything modern - hang their whole interface off
      # wrapper panes that report a zero-size rectangle, so treating invisible
      # as a dead end finds nothing but the title bar.
      if ($node.depth -lt 16) {
        $child = $walker.GetFirstChild($el)
        while ($null -ne $child -and $queue.Count -lt 1200) {
          $queue.Enqueue(@{ el = $child; depth = $node.depth + 1 })
          $child = $walker.GetNextSibling($child)
        }
      }
    } catch {
      # Windows disappear mid-walk all the time. Skipping one element is always
      # better than failing the whole snapshot.
    }
  }

  return @{
    window = $window.Title
    pid = $window.Pid
    handle = $window.Handle
    bounds = @{ x = $window.X; y = $window.Y; width = $window.Width; height = $window.Height }
    elements = @($elements)
    text = (($texts | Select-Object -Unique) -join "`n")
    truncated = ($index -ge $limit)
  }
}

# Numbers only ever mean something relative to the window they were read from.
# Acting on a stale number is not a harmless miss - the same index in a
# different application is a real control that will really be pressed - so a
# mismatch is refused rather than guessed at.
function Get-Element([int]$ref) {
  if (-not $script:Refs.ContainsKey($ref)) {
    throw "There is no element [$ref] in the last listing. Call desktop_look again and use a number from it."
  }
  if (-not (Get-WindowByHandle $script:RefWindow)) {
    throw "The window those numbers came from ('$script:RefTitle') has closed. Call desktop_look again."
  }
  return $script:Refs[$ref]
}

# Prefer the accessibility pattern over a synthetic click: Invoke reaches
# controls that are scrolled out of view or behind another window, and cannot
# miss. The mouse is the fallback for controls that expose no pattern at all.
function Invoke-Element([int]$ref) {
  $el = Get-Element $ref
  $pattern = $null
  if ($el.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke(); return 'invoked'
  }
  if ($el.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
    $pattern.Toggle(); return 'toggled'
  }
  if ($el.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    $pattern.Select(); return 'selected'
  }
  if ($el.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
    if ($pattern.Current.ExpandCollapseState -eq 'Collapsed') { $pattern.Expand() } else { $pattern.Collapse() }
    return 'expanded'
  }
  $box = $script:RefBoxes[$ref]
  [Native]::Click($box.x, $box.y, $false, 1)
  return 'clicked'
}

function Set-ElementText([int]$ref, [string]$text) {
  $el = Get-Element $ref
  $pattern = $null
  if ($el.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and
      -not $pattern.Current.IsReadOnly) {
    $pattern.SetValue($text); return 'set'
  }
  # No value pattern: focus it and type like a person would.
  try { $el.SetFocus() } catch {
    $box = $script:RefBoxes[$ref]
    [Native]::Click($box.x, $box.y, $false, 1)
  }
  Start-Sleep -Milliseconds 80
  [Native]::TypeUnicode($text)
  return 'typed'
}

$script:KeyMap = @{
  'enter'=0x0D; 'return'=0x0D; 'tab'=0x09; 'escape'=0x1B; 'esc'=0x1B; 'space'=0x20
  'backspace'=0x08; 'delete'=0x2E; 'del'=0x2E; 'home'=0x24; 'end'=0x23
  'pageup'=0x21; 'pagedown'=0x22; 'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27
  'ctrl'=0x11; 'control'=0x11; 'alt'=0x12; 'shift'=0x10; 'win'=0x5B; 'meta'=0x5B
  'f1'=0x70; 'f2'=0x71; 'f3'=0x72; 'f4'=0x73; 'f5'=0x74; 'f6'=0x75
  'f7'=0x76; 'f8'=0x77; 'f9'=0x78; 'f10'=0x79; 'f11'=0x7A; 'f12'=0x7B
}

function Send-Keys([string]$combo) {
  $codes = New-Object Collections.Generic.List[uint16]
  foreach ($part in ($combo -split '\+')) {
    $key = $part.Trim().ToLower()
    if ($key -eq '') { continue }
    if ($script:KeyMap.ContainsKey($key)) { $codes.Add([uint16]$script:KeyMap[$key]) }
    elseif ($key.Length -eq 1) {
      $codes.Add([uint16][byte][char]([string]$key).ToUpper())
    } else { throw "Unknown key '$part'." }
  }
  if ($codes.Count -eq 0) { throw "No keys given." }
  [Native]::KeyStroke($codes.ToArray())
}

$script:JpegCodec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                    Where-Object { $_.MimeType -eq 'image/jpeg' }

function Get-ScreenJpeg([int]$quality = 55, $window = $null, [int]$maxWidth = 1280) {
  if ($window) {
    $x = $window.X; $y = $window.Y; $w = $window.Width; $h = $window.Height
  } else {
    $v = [Windows.Forms.SystemInformation]::VirtualScreen
    $x = $v.Left; $y = $v.Top; $w = $v.Width; $h = $v.Height
  }
  # A window dragged partly off-screen would otherwise ask for a bitmap with a
  # negative or zero dimension and throw.
  if ($w -lt 1) { $w = 1 }
  if ($h -lt 1) { $h = 1 }

  # Sending native resolution is what made frames 391KB: a three-monitor desktop
  # is enormous, and the phone showing it is 400px wide. Scaling before encoding
  # cuts both the bytes and the encode time, which is what actually caps the
  # frame rate.
  $scale = 1.0
  if ($maxWidth -gt 0 -and $w -gt $maxWidth) { $scale = $maxWidth / [double]$w }
  $outW = [Math]::Max(1, [int]($w * $scale))
  $outH = [Math]::Max(1, [int]($h * $scale))

  $grab = New-Object Drawing.Bitmap($w, $h)
  $graphics = [Drawing.Graphics]::FromImage($grab)
  $scaled = $null
  try {
    $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object Drawing.Size($w, $h)))

    $image = $grab
    if ($scale -lt 1.0) {
      $scaled = New-Object Drawing.Bitmap($outW, $outH)
      $sg = [Drawing.Graphics]::FromImage($scaled)
      try {
        # Bilinear, not bicubic: at these sizes the quality difference is
        # invisible and bicubic costs about three times as much.
        $sg.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::Bilinear
        $sg.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighSpeed
        $sg.DrawImage($grab, 0, 0, $outW, $outH)
      } finally { $sg.Dispose() }
      $image = $scaled
    }

    $params = New-Object Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object Drawing.Imaging.EncoderParameter(
      [Drawing.Imaging.Encoder]::Quality, [long]$quality)
    $stream = New-Object IO.MemoryStream
    $image.Save($stream, $script:JpegCodec, $params)
    return @{
      frame = [Convert]::ToBase64String($stream.ToArray())
      width = $outW; height = $outH
    }
  } finally {
    $graphics.Dispose(); $grab.Dispose()
    if ($scaled) { $scaled.Dispose() }
  }
}

# -- command dispatch --------------------------------------------------

# Under Set-StrictMode, reading a property that is not there is an error rather
# than $null - and every one of these arguments is optional, so they all go
# through here.
function Get-Arg($obj, [string]$name, $fallback = $null) {
  if ($null -eq $obj) { return $fallback }
  $prop = $obj.PSObject.Properties[$name]
  if ($null -eq $prop -or $null -eq $prop.Value) { return $fallback }
  return $prop.Value
}

function Invoke-Command2([string]$cmd, $a) {
  switch ($cmd) {
    'ping' { return @{ ok = $true; pid = $PID } }

    'windows' {
      $list = [Native]::ListWindows() | ForEach-Object {
        @{ title = $_.Title; pid = $_.Pid; handle = $_.Handle
           bounds = @{ x = $_.X; y = $_.Y; width = $_.Width; height = $_.Height }
           minimized = $_.Minimized; foreground = $_.Foreground }
      }
      return @{ windows = @($list) }
    }

    'focus' {
      $spec = Get-Arg $a 'window'
      $win = Resolve-Window $spec
      if (-not $win) { throw "No open window matches '$spec'." }
      [void][Native]::Focus([IntPtr]$win.Handle)
      Start-Sleep -Milliseconds 220
      return Get-Snapshot (Resolve-Window $win.Title)
    }

    'look' {
      $spec = Get-Arg $a 'window'
      $win = Resolve-Window $spec
      if (-not $win) { throw "No open window matches '$spec'." }
      return Get-Snapshot $win
    }

    'click' {
      $ref = Get-Arg $a 'ref'
      if ($null -ne $ref) {
        $how = Invoke-Element ([int]$ref)
        Start-Sleep -Milliseconds 250
        return @{ action = $how; ref = [int]$ref }
      }
      $x = Get-Arg $a 'x'; $y = Get-Arg $a 'y'
      if ($null -ne $x -and $null -ne $y) {
        $times = if (Get-Arg $a 'double') { 2 } else { 1 }
        $right = ((Get-Arg $a 'button') -eq 'right')
        [Native]::Click([int]$x, [int]$y, $right, $times)
        Start-Sleep -Milliseconds 250
        return @{ action = 'clicked'; x = [int]$x; y = [int]$y }
      }
      throw 'Give either a ref from the last look, or x and y coordinates.'
    }

    'type' {
      $ref = Get-Arg $a 'ref'
      $text = [string](Get-Arg $a 'text' '')
      if ($null -ne $ref) {
        $how = Set-ElementText ([int]$ref) $text
      } else {
        [Native]::TypeUnicode($text)
        $how = 'typed'
      }
      if (Get-Arg $a 'submit') {
        Start-Sleep -Milliseconds 120
        Send-Keys 'enter'
      }
      Start-Sleep -Milliseconds 200
      return @{ action = $how }
    }

    'key' {
      $keys = [string](Get-Arg $a 'keys' '')
      Send-Keys $keys
      Start-Sleep -Milliseconds 200
      return @{ action = 'pressed'; keys = $keys }
    }

    'scroll' {
      $win = Resolve-Window (Get-Arg $a 'window')
      if (-not $win) { throw 'No window to scroll.' }
      $notches = [int](Get-Arg $a 'amount' 3)
      if ($notches -eq 0) { $notches = 3 }
      if ((Get-Arg $a 'direction' 'down') -eq 'up') { $notches = [Math]::Abs($notches) }
      else { $notches = -[Math]::Abs($notches) }
      [Native]::Scroll(($win.X + $win.Width / 2), ($win.Y + $win.Height / 2), $notches)
      Start-Sleep -Milliseconds 250
      return @{ action = 'scrolled' }
    }

    'launch' {
      $target = [string](Get-Arg $a 'app' '')
      if (-not $target) { throw 'Say which application to launch.' }
      $argv = [string](Get-Arg $a 'args' '')
      $before = ([Native]::ListWindows() | ForEach-Object { $_.Handle })
      if ($argv) { Start-Process -FilePath $target -ArgumentList $argv | Out-Null }
      else { Start-Process -FilePath $target | Out-Null }

      # Wait for a window that was not there before, rather than a fixed sleep:
      # Notepad appears in 200ms and Word can take eight seconds.
      $appeared = $null
      for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        $now = [Native]::ListWindows()
        $appeared = $now | Where-Object { $before -notcontains $_.Handle } | Select-Object -First 1
        if ($appeared) { break }
      }
      if (-not $appeared) { return @{ action = 'launched'; note = 'No new window appeared yet.' } }
      [void][Native]::Focus([IntPtr]$appeared.Handle)

      # A window exists well before its contents do. Store apps in particular
      # show a frame first and populate the interface a beat later, so snapshot
      # until something to act on actually turns up rather than after a guess
      # at how long that takes.
      $snapshot = $null
      for ($i = 0; $i -lt 8; $i++) {
        Start-Sleep -Milliseconds 400
        $live = Get-WindowByHandle $appeared.Handle
        if (-not $live) { break }
        $snapshot = Get-Snapshot $live
        if (@($snapshot.elements).Count -gt 3) { break }
      }
      if (-not $snapshot) { return @{ action = 'launched'; note = 'The window closed again immediately.' } }
      return $snapshot
    }

    'close' {
      $spec = Get-Arg $a 'window'
      $win = Resolve-Window $spec
      if (-not $win) { throw "No open window matches '$spec'." }
      [Native]::CloseWindow([IntPtr]$win.Handle)
      Start-Sleep -Milliseconds 300
      return @{ action = 'closed'; title = $win.Title }
    }

    'capture' {
      $quality = [int](Get-Arg $a 'quality' 55)
      $maxWidth = [int](Get-Arg $a 'maxWidth' 1280)
      $win = $null
      $spec = Get-Arg $a 'window'
      if ($spec) { $win = Resolve-Window $spec }
      $shot = Get-ScreenJpeg $quality $win $maxWidth
      $front = Resolve-Window $null
      $shot.title = if ($front) { $front.Title } else { 'Desktop' }
      return $shot
    }

    default { throw "Unknown command '$cmd'." }
  }
}

# -- the loop ----------------------------------------------------------

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }

  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    # Not $args - that is an automatic variable and assigning to it here would
    # quietly shadow the one every function call depends on.
    $callArgs = $request.PSObject.Properties['args']
    $callArgs = if ($callArgs -and $callArgs.Value) { $callArgs.Value } else { New-Object PSObject }
    $result = Invoke-Command2 ([string]$request.cmd) $callArgs
    $reply = @{ id = $id; ok = $true; result = $result }
  } catch {
    $reply = @{ id = $id; ok = $false; error = "$($_.Exception.Message)" }
  }

  # Depth matters: the default of 2 silently turns nested bounds objects into
  # the literal string "System.Collections.Hashtable".
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}
