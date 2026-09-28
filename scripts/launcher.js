/**
 * The quick launcher: press a key anywhere, type, and it is sent.
 *
 * The gap this closes is small and it is the whole difference between a web app
 * and an assistant. Everything the project can do was already reachable — by
 * finding a browser window, finding the tab, and clicking into it. Nobody does
 * that for a passing thought, so passing thoughts never got asked.
 *
 * There is no native module here, deliberately. The window is the browser
 * already on the machine, opened in application mode — no address bar, no tabs,
 * no thirty megabytes of Chromium bundled a second time. The hotkey is the only
 * part that genuinely needs the operating system, and each of the three has its
 * own honest answer:
 *
 *   Windows  RegisterHotKey through a PowerShell host, started here. Works out
 *            of the box.
 *   macOS    no dependency-free way to claim a global key. The desktop already
 *            has one — Shortcuts, or Automator's Quick Action — so this prints
 *            the exact command to bind and gets out of the way.
 *   Linux    the same, through the desktop environment's own keyboard settings.
 *            GNOME can be configured from here with `--install`.
 *
 * `node scripts/launcher.js --open` is the command those bindings run, so the
 * three platforms differ only in what presses the button.
 *
 *   node scripts/launcher.js              watch for the hotkey (Windows)
 *   node scripts/launcher.js --open       open the window now
 *   node scripts/launcher.js --install    bind the hotkey (GNOME)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}
loadEnvFile(path.join(root, '.env'));

const flags = new Set(process.argv.slice(2));
const PORT = process.env.PORT || 5173;
const URL_BASE = (process.env.LAUNCHER_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
/**
 * `ctrl+shift+Space` rather than the more obvious `ctrl+alt+Space`.
 *
 * Alt+Space combinations are claimed by input-method editors on a great many
 * machines — anyone typing Vietnamese, Chinese or Japanese has one — and a
 * launcher whose default key silently does nothing on the first run is worse
 * than one that asks. `--fallbacks` below covers the rest.
 */
const HOTKEY = process.env.LAUNCHER_HOTKEY || 'ctrl+shift+Space';
const FALLBACKS = ['ctrl+alt+shift+Space', 'ctrl+shift+J', 'ctrl+alt+shift+F9'];
const WINDOW = { width: 720, height: 132 };

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/** Split "ctrl+alt+Space" into the modifiers and the key itself. */
function splitHotkey(value) {
  const parts = String(value).split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() || 'Space';
  return { modifiers: parts.join('+') || 'ctrl+alt', key };
}

// ── the window ────────────────────────────────────────────────────────

/**
 * Chromium browsers in `--app` mode give a frameless window with no chrome at
 * all, which is what makes this feel like a launcher rather than a browser
 * showing a small page. Firefox has no equivalent, so it is not in the list —
 * the fallback below hands the URL to whatever the OS considers the default and
 * accepts that it arrives as an ordinary tab.
 */
const CHROMIUM = IS_WIN
  ? [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    ]
  : IS_MAC
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser'];

function findChromium() {
  const configured = process.env.LAUNCHER_BROWSER;
  if (configured && fs.existsSync(configured)) return configured;
  return CHROMIUM.find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * A separate profile directory, and that is not a detail.
 *
 * Launched into the ordinary profile, Chrome treats the window as one more
 * window of a browser that is already running — so `--window-size` is ignored,
 * and closing it can take the user's real session with it. A profile of its own
 * makes it a genuinely separate window that opens where it was told to.
 */
const PROFILE = path.join(process.env.DATA_DIR || path.join(root, 'data'), 'launcher-profile');

function openWindow() {
  const url = `${URL_BASE}/launcher.html`;
  const browser = findChromium();

  if (browser) {
    fs.mkdirSync(PROFILE, { recursive: true });
    const child = spawn(
      browser,
      [
        `--app=${url}`,
        `--window-size=${WINDOW.width},${WINDOW.height}`,
        `--user-data-dir=${PROFILE}`,
        '--no-first-run',
        '--no-default-browser-check',
        // The launcher is a text box. Nothing here needs to survive a restart,
        // and a launcher that quietly accumulates state is a surprise.
        '--disable-background-networking',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    child.on('error', (err) => console.error(`  Could not open the launcher window: ${err.message}`));
    child.unref();
    return;
  }

  // No Chromium anywhere: the default browser still works, it just looks like a
  // tab. Better than refusing to open at all.
  const [command, args] = IS_WIN ? ['cmd', ['/c', 'start', '', url]] : IS_MAC ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.error(`  Could not open ${url}.`));
  child.unref();
}

// ── binding the key ───────────────────────────────────────────────────

const COMMAND = `${process.execPath} ${path.join(here, 'launcher.js')} --open`;

function printManualInstructions() {
  const { modifiers, key } = splitHotkey(HOTKEY);
  console.log(`\n  This is the command to bind:\n\n    ${COMMAND}\n`);
  if (IS_MAC) {
    console.log('  macOS has no way for a program to claim a global key without being granted');
    console.log('  Accessibility rights, so bind it where the system already offers to:\n');
    console.log('    Shortcuts → File → New Shortcut → Run Shell Script → paste the command,');
    console.log(`    then Shortcut Details → Add Keyboard Shortcut → ${modifiers}+${key}.\n`);
  } else {
    console.log('  Bind it in your desktop\'s keyboard settings:\n');
    console.log('    GNOME    Settings → Keyboard → Custom Shortcuts  (or run this with --install)');
    console.log('    KDE      System Settings → Shortcuts → Custom Shortcuts');
    console.log('    i3/sway  bindsym in your config\n');
    console.log(`    Suggested key: ${modifiers}+${key}\n`);
  }
}

/** GNOME keeps custom shortcuts in dconf, so this one can be done for them. */
function installGnome() {
  const { modifiers, key } = splitHotkey(HOTKEY);
  const binding = `<${modifiers.split('+').join('><')}>${key}`;
  const slot = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/ai-remote/';

  const set = (property, value) =>
    spawnSync('gsettings', [
      'set',
      `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${slot}`,
      property,
      value,
    ]);

  const probe = spawnSync('gsettings', ['get', 'org.gnome.settings-daemon.plugins.media-keys', 'custom-keybindings']);
  if (probe.error) {
    console.error('  gsettings is not available — this is not a GNOME desktop.');
    printManualInstructions();
    return;
  }

  const existing = String(probe.stdout || '[]').trim();
  if (!existing.includes(slot)) {
    const list = existing === '@as []' || existing === '[]' ? `['${slot}']` : existing.replace(/\]$/, `, '${slot}']`);
    spawnSync('gsettings', ['set', 'org.gnome.settings-daemon.plugins.media-keys', 'custom-keybindings', list]);
  }
  set('name', 'Synapsez launcher');
  set('command', COMMAND);
  set('binding', binding);

  console.log(`\n  Bound ${modifiers}+${key} to the launcher. Press it anywhere.\n`);
}

// ── watching for it ───────────────────────────────────────────────────

const HOST_SCRIPT = path.join(here, 'hotkey.ps1');

const powershellArgs = (extra) => [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  HOST_SCRIPT,
  ...extra,
];

/**
 * Is this combination actually free?
 *
 * Worth asking before parking on it, because the failure is otherwise silent
 * from the user's side: they press the key, the application that already owns it
 * responds, and the launcher looks broken rather than outvoted.
 */
function isAvailable(hotkey) {
  const { modifiers, key } = splitHotkey(hotkey);
  const probe = spawnSync('powershell.exe', powershellArgs(['-Modifiers', modifiers, '-Key', key, '-Probe']), {
    windowsHide: true,
  });
  return probe.status === 0;
}

/** The configured key if it is free, otherwise the first fallback that is. */
function chooseHotkey() {
  if (isAvailable(HOTKEY)) return { hotkey: HOTKEY, substituted: false };
  for (const candidate of FALLBACKS) {
    if (isAvailable(candidate)) return { hotkey: candidate, substituted: true };
  }
  return null;
}

function watchWindows() {
  const chosen = chooseHotkey();
  if (!chosen) {
    console.error(`  ${HOTKEY} is already taken, and so is every fallback.`);
    console.error('  Set LAUNCHER_HOTKEY in .env to a combination nothing else claims.\n');
    process.exit(1);
  }
  if (chosen.substituted) {
    console.log(`  ${HOTKEY} is claimed by another program, so using ${chosen.hotkey} instead.`);
    console.log('  Set LAUNCHER_HOTKEY in .env to choose your own.\n');
  }

  const { modifiers, key } = splitHotkey(chosen.hotkey);

  const host = spawn('powershell.exe', powershellArgs(['-Modifiers', modifiers, '-Key', key]), {
    windowsHide: true,
  });

  let buffer = '';
  host.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const value = line.trim();
      if (value === 'hotkey') {
        console.log(`  ${new Date().toLocaleTimeString()}  opening the launcher`);
        openWindow();
      } else if (value.startsWith('ready')) {
        console.log(`  Listening for ${modifiers}+${key}. Press it from anywhere.\n`);
      }
    }
  });

  host.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) console.error(`  ${message}`);
  });

  host.on('close', (code) => {
    console.error(`\n  The hotkey listener stopped (exit ${code}).`);
    console.error('  Another program may have claimed the combination. Set LAUNCHER_HOTKEY in .env to change it.\n');
    process.exit(code || 1);
  });

  process.on('SIGINT', () => {
    host.kill();
    process.exit(0);
  });
}

// ── go ────────────────────────────────────────────────────────────────

if (flags.has('--open')) {
  openWindow();
} else if (flags.has('--install')) {
  if (IS_WIN) {
    console.log('\n  On Windows nothing needs installing — run this without --install and leave it going.\n');
  } else if (IS_MAC) {
    printManualInstructions();
  } else {
    installGnome();
  }
} else {
  console.log('\n  Synapsez launcher\n');
  console.log(`    app:    ${URL_BASE}`);
  console.log(`    hotkey: ${HOTKEY}\n`);

  if (IS_WIN) {
    watchWindows();
  } else {
    console.log('  Nothing to run in the background on this platform — the desktop owns the key.');
    printManualInstructions();
  }
}
