/**
 * The machine itself — clipboard, notifications, processes, health.
 *
 * Everything here works on Windows, macOS and Linux. That is the point: the
 * `desktop_*` tools drive applications through Windows UI Automation and stop at
 * the Windows border, so an assistant that only had those was three quarters
 * useless on a Mac. These are the small, constant conveniences — what did I just
 * copy, tell me when you are done, why is the fan spinning — and they should not
 * depend on which laptop somebody opened.
 *
 * Where a platform needs a helper program (clipboard on Linux) the candidates
 * are tried in turn and the failure says which packages would fix it, rather
 * than reporting a bare non-zero exit.
 */
import os from 'node:os';
import { spawn } from 'node:child_process';

const MAX_TEXT = 20_000;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const clip = (text) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[truncated — ${text.length - MAX_TEXT} more characters]` : text;

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Run a program and resolve its stdout.
 *
 * `input` goes in on stdin rather than in the argument list, because clipboard
 * text is arbitrary — newlines, quotes, megabytes of it — and an argument list
 * is the wrong shape for all three.
 */
function run(command, args, { input = null, timeout = 15_000, env = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT' ? `${command} is not installed on this computer.` : err.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`${command} did not finish within ${timeout}ms.`));
      if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}.`));
      resolve(stdout);
    });

    if (input !== null) {
      child.stdin.on('error', () => {}); // the child may exit before we finish writing
      child.stdin.end(input, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

/**
 * PowerShell, with the console encodings pinned to UTF-8.
 *
 * Without this a pasted "café" or any Vietnamese text comes back mangled: the
 * default console code page is not UTF-8, and Node decodes the bytes as if it
 * were.
 */
function powershell(script, options = {}) {
  const prelude =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::InputEncoding=[Text.Encoding]::UTF8;';
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + script],
    options,
  );
}

/** Try each command in turn; the first that runs wins. */
async function firstOf(candidates, missing) {
  const reasons = [];
  for (const { command, args, options } of candidates) {
    try {
      return await run(command, args, options);
    } catch (err) {
      reasons.push(`${command}: ${err.message}`);
    }
  }
  throw new Error(`${missing}\n${reasons.join('\n')}`);
}

// ── clipboard ─────────────────────────────────────────────────────────

async function clipboardRead() {
  let text;
  if (IS_WIN) {
    text = await powershell('Get-Clipboard -Raw');
  } else if (IS_MAC) {
    text = await run('pbpaste', []);
  } else {
    text = await firstOf(
      [
        { command: 'wl-paste', args: ['--no-newline'] },
        { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
        { command: 'xsel', args: ['--clipboard', '--output'] },
      ],
      'No clipboard tool is installed. Install wl-clipboard (Wayland) or xclip (X11).',
    );
  }

  const value = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (!value.trim()) return 'The clipboard is empty, or holds something that is not text (an image or a file).';
  return clip(`Clipboard (${value.length} characters):\n${value}`);
}

async function clipboardWrite({ text }) {
  const value = String(text ?? '');
  if (!value) throw new Error('Give the text to put on the clipboard.');

  if (IS_WIN) {
    // Read stdin inside PowerShell rather than passing the text as an argument:
    // quoting arbitrary text through a command line is a bug waiting to happen.
    await powershell('Set-Clipboard -Value ([Console]::In.ReadToEnd())', { input: value });
  } else if (IS_MAC) {
    await run('pbcopy', [], { input: value });
  } else {
    await firstOf(
      [
        { command: 'wl-copy', args: [], options: { input: value } },
        { command: 'xclip', args: ['-selection', 'clipboard'], options: { input: value } },
        { command: 'xsel', args: ['--clipboard', '--input'], options: { input: value } },
      ],
      'No clipboard tool is installed. Install wl-clipboard (Wayland) or xclip (X11).',
    );
  }

  const preview = value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return `Copied ${value.length} characters to the clipboard. They can paste it now with Ctrl+V.\n"${preview}"`;
}

// ── notifications ─────────────────────────────────────────────────────

/**
 * The toast is sent under PowerShell's own application id.
 *
 * Windows will not show a toast from an app it has never heard of, and the
 * worker is not a registered app — borrowing the shell's identity is what makes
 * the notification appear at all. If the WinRT path is unavailable the tray
 * balloon is the fallback, which needs the process to outlive the call by a few
 * seconds or the balloon vanishes with it.
 */
const WINDOWS_TOAST = `
$ErrorActionPreference = 'Stop'
$title = $env:AIR_TITLE
$body  = $env:AIR_BODY
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] > $null
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $nodes = $template.GetElementsByTagName('text')
  $nodes.Item(0).AppendChild($template.CreateTextNode($title)) > $null
  $nodes.Item(1).AppendChild($template.CreateTextNode($body)) > $null
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($template))
  'toast'
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Visible = $true
  $icon.ShowBalloonTip(6000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Sleep -Seconds 6
  $icon.Dispose()
  'balloon'
}`;

/** Escape for embedding in an AppleScript double-quoted string. */
const applescriptString = (value) => `"${String(value).replace(/[\\"]/g, '\\$&').replace(/\n/g, ' ')}"`;

async function notify({ title, body = '' }) {
  const heading = String(title || '').trim();
  if (!heading) throw new Error('Give the notification a title.');
  const message = String(body || '').trim();

  if (IS_WIN) {
    await powershell(WINDOWS_TOAST, { env: { AIR_TITLE: heading, AIR_BODY: message }, timeout: 20_000 });
  } else if (IS_MAC) {
    await run('osascript', [
      '-e',
      `display notification ${applescriptString(message || heading)} with title ${applescriptString(heading)}`,
    ]);
  } else {
    await firstOf(
      [
        { command: 'notify-send', args: ['--app-name=Synapsez', heading, message] },
        { command: 'zenity', args: ['--notification', `--text=${heading}\n${message}`] },
      ],
      'No notification daemon is installed. Install libnotify (notify-send).',
    );
  }

  return `Notification shown on their screen: "${heading}". They may not be looking at it, so it is a nudge and not a reply — do not treat it as delivered.`;
}

// ── processes ─────────────────────────────────────────────────────────

const WINDOWS_PROCESSES = `
Get-Process | Where-Object { $_.Id -ne 0 } | ForEach-Object {
  $cpu = 0.0
  try { $cpu = [double]$_.CPU } catch {}
  '{0}|{1}|{2}|{3}' -f $_.Id, $_.ProcessName, $_.WorkingSet64, $cpu
}`;

/**
 * One shape of process row from three very different sources.
 *
 * Windows reports total CPU *seconds* consumed since start; ps reports a
 * *percentage* of one core right now. They are not the same number and are
 * labelled differently below rather than being averaged into a lie.
 */
async function readProcesses() {
  if (IS_WIN) {
    const out = await powershell(WINDOWS_PROCESSES, { timeout: 20_000 });
    return out
      .split('\n')
      .map((line) => line.trim().split('|'))
      .filter((parts) => parts.length === 4 && parts[0])
      .map(([pid, name, rss, cpu]) => ({
        pid: Number(pid),
        name,
        rss: Number(rss) || 0,
        cpu: Number(cpu) || 0,
      }));
  }

  // BSD and GNU ps agree on this subset, so macOS and Linux share one call.
  const out = await run('ps', ['-eo', 'pid,pcpu,rss,comm']);
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({
      pid: Number(m[1]),
      cpu: Number(m[2]),
      rss: Number(m[3]) * 1024, // ps reports kilobytes
      name: m[4].split('/').pop(),
    }));
}

async function processList({ filter = '', sort = 'memory', limit = 20 } = {}) {
  let rows = await readProcesses();
  const needle = String(filter || '').trim().toLowerCase();
  if (needle) rows = rows.filter((p) => p.name.toLowerCase().includes(needle));
  if (!rows.length) {
    return needle ? `Nothing is running whose name contains "${filter}".` : 'No processes were returned.';
  }

  const byCpu = String(sort).toLowerCase() === 'cpu';
  rows.sort((a, b) => (byCpu ? b.cpu - a.cpu : b.rss - a.rss));

  const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const shown = rows.slice(0, take);
  const width = Math.max(4, ...shown.map((p) => p.name.length));
  const cpuLabel = IS_WIN ? 'CPU (total s)' : 'CPU %';

  const body = shown
    .map(
      (p) =>
        `${String(p.pid).padStart(7)}  ${p.name.padEnd(width)}  ${formatBytes(p.rss).padStart(7)}  ${
          IS_WIN ? p.cpu.toFixed(1) : `${p.cpu.toFixed(1)}%`
        }`,
    )
    .join('\n');

  return clip(
    `${rows.length} process${rows.length === 1 ? '' : 'es'}${needle ? ` matching "${filter}"` : ''}, ` +
      `top ${shown.length} by ${byCpu ? 'CPU' : 'memory'}:\n` +
      `${'PID'.padStart(7)}  ${'NAME'.padEnd(width)}  ${'MEMORY'.padStart(7)}  ${cpuLabel}\n${body}`,
  );
}

async function processKill({ pid, name, force = false }) {
  const targets = [];

  if (pid !== undefined && pid !== null && String(pid) !== '') {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`"${pid}" is not a process id.`);
    const known = (await readProcesses().catch(() => [])).find((p) => p.pid === id);
    targets.push({ pid: id, name: known?.name || 'unknown' });
  } else if (String(name || '').trim()) {
    const needle = String(name).trim().toLowerCase();
    const matches = (await readProcesses()).filter(
      (p) => p.name.toLowerCase() === needle || p.name.toLowerCase() === `${needle}.exe`,
    );
    if (!matches.length) {
      throw new Error(
        `Nothing named "${name}" is running. Call process_list with a filter to see the real name — it may differ from the window title.`,
      );
    }
    targets.push(...matches);
  } else {
    throw new Error('Give either a pid or a process name.');
  }

  // Never take the worker down with the thing it was asked to stop.
  const self = targets.find((t) => t.pid === process.pid);
  if (self) throw new Error('That is the Synapsez worker itself. Refusing — it would kill this connection.');

  const done = [];
  const failed = [];
  for (const target of targets) {
    try {
      if (IS_WIN && force) {
        await run('taskkill', ['/PID', String(target.pid), '/F', '/T']);
      } else {
        process.kill(target.pid, force ? 'SIGKILL' : 'SIGTERM');
      }
      done.push(`${target.name} (${target.pid})`);
    } catch (err) {
      failed.push(`${target.name} (${target.pid}): ${err.code === 'EPERM' ? 'not permitted' : err.message}`);
    }
  }

  const lines = [];
  if (done.length) {
    lines.push(
      `Stopped ${done.join(', ')}${force ? ' by force' : ''}. Anything unsaved in ${
        done.length === 1 ? 'it' : 'them'
      } is gone.`,
    );
  }
  if (failed.length) lines.push(`Could not stop: ${failed.join('; ')}`);
  if (!done.length && !force) lines.push('A polite request may be ignored. Pass force to insist.');
  return lines.join('\n');
}

// ── health ────────────────────────────────────────────────────────────

function cpuSample() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value;
      if (kind === 'idle') idle += value;
    }
  }
  return { idle, total };
}

/** Busy share of all cores, measured over a short window rather than guessed. */
async function cpuBusy() {
  const first = cpuSample();
  await new Promise((r) => setTimeout(r, 250));
  const second = cpuSample();
  const total = second.total - first.total;
  if (total <= 0) return null;
  return (1 - (second.idle - first.idle) / total) * 100;
}

const WINDOWS_DISKS = `
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null -or $_.Free -ne $null } | ForEach-Object {
  '{0}|{1}|{2}' -f $_.Name, [int64]$_.Used, [int64]$_.Free
}`;

/** Disks are best-effort: a machine that will not report them still has a CPU. */
async function disks() {
  try {
    if (IS_WIN) {
      const out = await powershell(WINDOWS_DISKS);
      return out
        .split('\n')
        .map((line) => line.trim().split('|'))
        .filter((parts) => parts.length === 3 && parts[0])
        .map(([name, used, free]) => {
          const usedBytes = Number(used) || 0;
          const freeBytes = Number(free) || 0;
          const size = usedBytes + freeBytes;
          return size > 0
            ? `  ${name}:  ${formatBytes(freeBytes)} free of ${formatBytes(size)} (${Math.round((usedBytes / size) * 100)}% used)`
            : null;
        })
        .filter(Boolean);
    }

    const out = await run('df', ['-kP']);
    return out
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 6 && /^\/dev\//.test(parts[0]))
      .map((parts) => {
        const size = Number(parts[1]) * 1024;
        const free = Number(parts[3]) * 1024;
        return `  ${parts[5]}  ${formatBytes(free)} free of ${formatBytes(size)} (${parts[4]} used)`;
      });
  } catch {
    return [];
  }
}

async function systemStats() {
  const [busy, volumes, processes] = await Promise.all([
    cpuBusy(),
    disks(),
    readProcesses().catch(() => []),
  ]);

  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = Math.round(((total - free) / total) * 100);
  const cores = os.cpus();

  const lines = [
    `${os.hostname()} — ${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
    `Up ${formatDuration(os.uptime())}, ${cores.length} cores${cores[0]?.model ? ` — ${cores[0].model.trim()}` : ''}`,
    `CPU: ${busy === null ? 'unavailable' : `${busy.toFixed(0)}% busy`}`,
    `Memory: ${formatBytes(total - free)} of ${formatBytes(total)} used (${usedPercent}%), ${formatBytes(free)} free`,
  ];

  if (volumes.length) lines.push('Disks:', ...volumes);

  if (processes.length) {
    const heaviest = [...processes].sort((a, b) => b.rss - a.rss).slice(0, 5);
    lines.push(
      `Heaviest: ${heaviest.map((p) => `${p.name} ${formatBytes(p.rss)}`).join(', ')}`,
      `${processes.length} processes running.`,
    );
  }

  // A judgement, not just numbers — the reason somebody asks is that something
  // feels wrong, and "94% used" without a verdict makes them do the reading.
  if (usedPercent >= 90) lines.push('Memory is nearly full — that is enough to make the machine feel slow.');
  else if (busy !== null && busy >= 85) lines.push('The CPU is pinned. Something is working hard.');

  return lines.join('\n');
}

// ── launching ─────────────────────────────────────────────────────────

/**
 * Start an application by name, on any of the three.
 *
 * `open_url` hands a path to the shell and lets the OS pick the app; this is the
 * other direction — name the app, optionally give it something to open. On
 * Windows `desktop_launch` does more (it waits for the window and can then drive
 * it), but it only exists there, so this is the portable floor.
 */
/**
 * Start-Process, with the app and its arguments arriving out of band.
 *
 * The name and the arguments come from the model, so they never appear in the
 * script text — they are read from the environment, the same way the toast above
 * takes its title and body. `Start-Process` resolves a bare name through
 * ShellExecute exactly as `start` did, so nothing is lost by leaving cmd behind.
 */
const WINDOWS_LAUNCH =
  "$ErrorActionPreference='Stop';" +
  '$app=$env:AIR_APP;$raw=$env:AIR_ARGS;' +
  'if([string]::IsNullOrEmpty($raw)){Start-Process -FilePath $app}' +
  'else{Start-Process -FilePath $app -ArgumentList ([string[]]($raw -split "`n"))}';

async function launchApp({ app, args = [] }) {
  const name = String(app || '').trim();
  if (!name) throw new Error('Name the application to start.');
  const extra = (Array.isArray(args) ? args : [args]).map(String).filter(Boolean);

  /**
   * Nothing legitimate carries a control character, and a newline is the one
   * that could still confuse an argument boundary — the arguments travel to
   * PowerShell as a single newline-separated environment variable. Same check,
   * and the same reasoning, as `openCommand` in worker/tools.js.
   */
  for (const value of [name, ...extra]) {
    if ([...value].some((ch) => ch.codePointAt(0) < 0x20)) {
      throw new Error('That application name or argument contains control characters, so nothing was started.');
    }
  }

  /**
   * Windows goes through PowerShell rather than cmd, and that is a security fix
   * rather than a preference.
   *
   * It used to be `cmd /c start "" <app> <args...>`. Node quotes an argument
   * only when it contains a space, a tab or a quote — so `&`, `|`, `^` and `>`
   * reached cmd.exe unquoted and cmd split on them. Measured on this machine:
   * `launch_app({ app: 'notepad&ver' })` ran `ver` as a second command, `|`
   * piped into one, and `>` created a file. The app name is chosen by the model,
   * and a model can be talked into things by a web page it is reading.
   *
   * It is graded `ordinary` in the tool catalogue, so under the default guarded
   * policy none of that stopped for approval first. The identical bug was found
   * and fixed in `open_url` — see the comment above `openCommand` in
   * worker/tools.js — and this call site was missed at the time.
   *
   * macOS and Linux always used an argv array with no shell, so they were never
   * affected and are unchanged.
   */
  if (IS_WIN) {
    try {
      await powershell(WINDOWS_LAUNCH, {
        env: { AIR_APP: name, AIR_ARGS: extra.join('\n') },
        timeout: 20_000,
      });
    } catch (err) {
      /**
       * PowerShell reports a missing program as a page of CategoryInfo with the
       * script echoed back, which is no use to anybody and puts the script text
       * into the transcript. Translated to the same sentence the POSIX branch
       * gives, so the model reads one answer whatever the platform.
       *
       * Worth noting this is now *reported* at all: `cmd /c start` returned
       * success for a name that does not exist and left Windows to show an error
       * box on the user's screen that the model never saw, so it would go on to
       * claim it had started something.
       */
      const said = String(err?.message || '');
      throw new Error(
        /cannot find the file|No such file|not recognized/i.test(said)
          ? `There is no application called "${name}" on this computer, or it is not on the PATH.`
          : `Could not start ${name}: ${said.split('\n')[0].trim()}`,
      );
    }
    return (
      `Started ${name}${extra.length ? ` with ${extra.join(' ')}` : ''} on their screen. ` +
      'Starting it is not the same as it being ready — say what you launched rather than assuming it worked.'
    );
  }

  const [command, argv] = IS_MAC
    ? ['open', ['-a', name, ...(extra.length ? ['--args', ...extra] : [])]]
    : [name, extra];

  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) =>
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `There is no application called "${name}" on this computer, or it is not on the PATH.`
            : `Could not start ${name}: ${err.message}`,
        ),
      ),
    );
    child.on('spawn', () => {
      // It has to outlive this call, or the app dies with the tool.
      child.unref();
      resolve(
        `Started ${name}${extra.length ? ` with ${extra.join(' ')}` : ''} on their screen. ` +
          'Starting it is not the same as it being ready — say what you launched rather than assuming it worked.',
      );
    });
  });
}

export const SYSTEM_IMPLEMENTATIONS = {
  clipboard_read: clipboardRead,
  clipboard_write: clipboardWrite,
  notify,
  process_list: processList,
  process_kill: processKill,
  system_stats: systemStats,
  launch_app: launchApp,
};
