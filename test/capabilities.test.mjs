/**
 * The capabilities that were missing, exercised for real.
 *
 * Separate from `npm test` because two of these need things the fast suite must
 * not: a browser, and the internet.
 *
 *   npm run test:capabilities
 *
 * Each check below exists because the tool it covers replaces a workaround that
 * did not work. `run_command` killed long-running commands at the timeout, so a
 * dev server could be written and never started. `web_fetch` returns text, so
 * there was no way to put a file on disk except shelling out to curl. And the app
 * told people to print PDFs by hand from the viewer, because printing one here was
 * assumed impossible — it is not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = path.join(os.tmpdir(), `ai-remote-capabilities-${process.pid}`);
fs.rmSync(WORKSPACE, { recursive: true, force: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
process.env.WORKSPACE = WORKSPACE;

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
/** Assert that a call fails, and that it fails for the stated reason. */
const refuses = async (label, run, pattern) => {
  try {
    await run();
    check(label, false, 'it succeeded when it should have refused');
  } catch (err) {
    check(label, pattern.test(err.message), err.message.slice(0, 90));
  }
};

const { setWorkspace } = await import('../worker/paths.js');
setWorkspace(WORKSPACE);
const { LOCAL_IMPLEMENTATIONS: tools } = await import('../worker/tools.js');

// ── long-running commands ───────────────────────────────────────────
section('a command that is not meant to finish');
{
  const ticker = 'node -e "let n=0;setInterval(()=>console.log(\'tick \'+(++n)),200)"';
  const started = await tools.run_background({ command: ticker, name: 'ticker', settle_ms: 1200 });
  check('it starts and stays up', /started/.test(started), started.split('\n')[0]);
  // The settle pause is the point: output already in hand means a failure is read
  // now rather than reported as a success and discovered two steps later.
  check('and its first output comes back with it', /tick/.test(started));

  const logs = await tools.run_background_logs({ id: 'ticker', lines: 5 });
  check('the log can be read later', /tick/.test(logs));
  check('and says it is still running', /running for/.test(logs), logs.split('\n')[0].slice(0, 70));

  const dead = await tools.run_background({ command: 'node -e "process.exit(3)"', name: 'boom', settle_ms: 800 });
  check('a command that dies immediately is reported as dead', /NOT running/.test(dead), dead.split('\n')[0]);
  check('and not as started', !/^\[boom\] started/.test(dead));

  check('the listing covers every job', /ticker/.test(await tools.run_background_logs({})));

  const stopped = await tools.run_background_stop({ id: 'ticker' });
  check('stopping works', /Stopped/.test(stopped));
  check('and it reads as exited afterwards', /exited/.test(await tools.run_background_logs({ id: 'ticker' })));

  await refuses(
    'an unknown id is refused rather than silently ignored',
    () => tools.run_background_stop({ id: 'never-existed' }),
    /no background command/i,
  );
}

// ── files, not text ─────────────────────────────────────────────────
section('putting a file on disk');
{
  const url = 'https://raw.githubusercontent.com/nodejs/node/main/LICENSE';
  const out = await tools.download_file({ url, path: 'LICENSE.txt' });
  check('the bytes land in the workspace', fs.existsSync(path.join(WORKSPACE, 'LICENSE.txt')), out.slice(0, 60));
  check('and the size is reported', /\d[\d,]* bytes/.test(out));

  await refuses(
    'it will not overwrite without being told to',
    () => tools.download_file({ url, path: 'LICENSE.txt' }),
    /already exists/,
  );

  // The same guard as `web_fetch`: the URL comes from a model, and a router's
  // admin panel is not a download.
  await refuses(
    'a private address is refused',
    () => tools.download_file({ url: 'http://127.0.0.1:9/x', path: 'no.bin' }),
    /private address/,
  );
  await refuses(
    'and so is a non-http scheme',
    () => tools.download_file({ url: 'file:///etc/passwd', path: 'no.bin' }),
    /http|valid URL/i,
  );

  // A partial file that looks whole is worse than no file.
  await refuses(
    'passing max_bytes stops the download',
    () => tools.download_file({ url, path: 'tiny.txt', max_bytes: 1024 }),
    /limit/,
  );
  check('and the partial file is removed', !fs.existsSync(path.join(WORKSPACE, 'tiny.txt')));
}

// ── a real PDF ──────────────────────────────────────────────────────
section('printing a PDF through the browser');
{
  // Accents are the whole reason this goes through a browser rather than a PDF
  // library: the advice it replaces was "print it yourself, your browser has the
  // fonts", and this is the same browser.
  const result = await tools.export_pdf({
    path: 'bao-gia',
    html: '<h1>Báo giá tháng 8</h1><p>Đầy đủ dấu: ă â ê ô ơ ư đ ạ ả ã ẵ ự ỹ</p>',
  });
  const file = path.join(WORKSPACE, 'bao-gia.pdf');
  check('the extension is added when missing', fs.existsSync(file), result.slice(0, 60));

  const bytes = fs.readFileSync(file);
  check('it really is a PDF', bytes.subarray(0, 5).toString('latin1') === '%PDF-', JSON.stringify(bytes.subarray(0, 5).toString('latin1')));
  check('with content in it', bytes.length > 1000, `${bytes.length} bytes`);

  await refuses('it needs something to print', () => tools.export_pdf({ path: 'x.pdf' }), /either/);
  await refuses(
    'and refuses two sources at once',
    () => tools.export_pdf({ path: 'x.pdf', html: '<p>a</p>', url: 'https://example.com' }),
    /not both/,
  );
}

// ── changing a picture ──────────────────────────────────────────────
section('editing an image');
{
  /**
   * Done through a canvas rather than by adding `sharp`.
   *
   * `sharp` means a native module with prebuilt binaries per platform and per Node
   * version — a real dependency in a project that keeps few. The browser is
   * already installed and has both a decoder and an encoder.
   */
  const logo = path.join(WORKSPACE, 'logo.png');
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'logo.png'), logo);
  const originalBytes = fs.statSync(logo).size;

  const resized = await tools.edit_image({ path: 'logo.png', width: 200 });
  check('it writes a new file beside the original', fs.existsSync(path.join(WORKSPACE, 'logo-edited.png')));
  // Never in place by default: an irreversible resize of somebody's only copy is
  // not something to do without being asked.
  check('and leaves the original alone', fs.statSync(logo).size === originalBytes);
  check('the width is what was asked for', /200×200/.test(resized), resized.match(/\d+×\d+/g)?.join(' from '));

  // A missing dimension keeps the proportions. Both given would stretch it, which
  // is never what anybody meant by "make it 800 wide".
  const tall = await tools.edit_image({ path: 'logo.png', height: 120, output: 'by-height' });
  check('giving only a height derives the width', /120×120/.test(tall), tall.match(/\d+×\d+/)?.[0]);

  const jpeg = await tools.edit_image({ path: 'logo.png', width: 400, format: 'jpeg', quality: 0.7, output: 'small' });
  const jpegPath = path.join(WORKSPACE, 'small.jpg');
  check('converting to jpeg writes .jpg', fs.existsSync(jpegPath), jpeg.slice(0, 50));
  const magic = fs.readFileSync(jpegPath).subarray(0, 3);
  check('and it really is a JPEG', magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff);
  check(
    'which is the point — it is far smaller',
    fs.statSync(jpegPath).size < originalBytes / 4,
    `${originalBytes.toLocaleString()} → ${fs.statSync(jpegPath).size.toLocaleString()} bytes`,
  );

  const cropped = await tools.edit_image({ path: 'logo.png', crop: { x: 0, y: 0, width: 256, height: 128 }, output: 'cropped' });
  check('crop keeps only the rectangle asked for', /256×128/.test(cropped), cropped.match(/\d+×\d+/)?.[0]);

  // A quarter turn swaps the canvas dimensions; a half turn does not.
  const turned = await tools.edit_image({ path: 'logo.png', width: 300, height: 100, rotate: 90, output: 'turned' });
  check('a quarter turn swaps the dimensions', /100×300/.test(turned), turned.match(/\d+×\d+/)?.[0]);

  await refuses(
    'asking for no change at all is refused',
    () => tools.edit_image({ path: 'logo.png' }),
    /Say what to change/,
  );
  fs.writeFileSync(path.join(WORKSPACE, 'notes.txt'), 'not an image');
  await refuses(
    'a file that is not an image is refused',
    () => tools.edit_image({ path: 'notes.txt', width: 10 }),
    /does not look like an image/,
  );
  await refuses(
    'a format a canvas cannot write is refused',
    () => tools.edit_image({ path: 'logo.png', format: 'tiff' }),
    /Cannot write/,
  );
}

// ── the sandbox is left as it was found ─────────────────────────────
section('printing does not disturb the sandbox');
{
  await tools.browser_open({ url: 'https://example.com' });
  const before = await tools.browser_tabs({});
  await tools.export_pdf({ path: 'second.pdf', html: '<p>second</p>' });
  const after = await tools.browser_tabs({});
  check(
    'the tab count is unchanged',
    (before.match(/\[\d+\]/g) || []).length === (after.match(/\[\d+\]/g) || []).length,
    `${(before.match(/\[\d+\]/g) || []).length} → ${(after.match(/\[\d+\]/g) || []).length}`,
  );
  check('and the assistant is still on a tab', /←/.test(after));
}

const { stopAllBackground } = await import('../worker/background.js');
await stopAllBackground();
const { closeBrowser } = await import('../worker/browser.js');
await closeBrowser();
fs.rmSync(WORKSPACE, { recursive: true, force: true });

console.log(
  failures === 0
    ? '\n\x1b[32mAll capability checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
