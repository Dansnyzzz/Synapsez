/**
 * `web_fetch` reads what it is pointed at, including the files.
 *
 * Two failures, both found the same afternoon by someone trying to build a quiz
 * from a past exam paper published as a PDF:
 *
 *   **"too large to read".** An 11MB PDF was refused before a byte was read,
 *   because the ceiling that protects the process from a runaway page was also
 *   the ceiling on a document. A page can be cut anywhere; a PDF cannot be cut
 *   at all, so the two need different numbers rather than one shared one.
 *
 *   **Binary as prose.** Anything that was not HTML came back decoded as UTF-8,
 *   so a PDF that *did* fit arrived as several thousand characters of mojibake
 *   which the model then paid for in every subsequent turn and could not read.
 *
 * So: documents get their own, larger ceiling and are parsed with the same
 * readers the chat uses for an attachment, and bytes that are neither text nor
 * a readable document are refused out loud instead of pasted in.
 *
 *   node test/webfetch.test.mjs
 */
import http from 'node:http';

process.env.ENCRYPTION_KEY ||= 'webfetch-test-key';
process.env.SESSION_SECRET ||= 'webfetch-test-secret';
// The fixture server is loopback, which `safeFetch` refuses by design.
process.env.ALLOW_PRIVATE_FETCH = '1';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
const { createDocument } = await import('../server/office/index.js');
const webFetch = CLOUD_IMPLEMENTATIONS.web_fetch;

/**
 * A real PDF, as big as asked for.
 *
 * Built here rather than checked in because the point of the test is the size,
 * and a 9MB fixture in the repository would be a 9MB fixture in every clone.
 * The padding is a PDF comment — legal anywhere outside a stream, ignored by
 * every reader, and it moves the byte offsets exactly the way real content
 * would, so the cross-reference table below has to be right.
 */
function makePdf(line, padBytes = 0) {
  const stream = `BT /F1 24 Tf 72 700 Td (${line}) Tj ET\n`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  let out = '%PDF-1.4\n';
  if (padBytes > 0) out += `%${'p'.repeat(padBytes)}\n`;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const bigPdf = makePdf('Cau 1: Dieu uoc quoc te nao dieu chinh mua ban hang hoa?', 9 * 1024 * 1024);
const docx = createDocument({ format: 'docx', name: 'report.docx', content: '# Quarterly report\n\nRevenue rose by 12%.' });

/* A picture: bytes that are not text and are not a document anyone can read. */
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048)]);

const routes = {
  '/exam.pdf': (res) => {
    // `application/octet-stream` on purpose: this is what the WordPress upload
    // directory the original report came from actually sends for a PDF.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bigPdf.length });
    res.end(bigPdf);
  },
  '/report.docx': (res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': docx.buffer.length });
    res.end(docx.buffer);
  },
  '/photo.png': (res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
  },
  '/page.html': (res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><style>b{}</style></head><body><h1>Tiêu đề</h1><p>Nội dung thật.</p></body></html>');
  },
  '/spacer.html': (res) => {
    // How most of the web is actually built: content separated by runs of empty
    // block elements doing the job of margins.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<html><body><h1>Tiêu đề</h1>' +
        '<div> </div>'.repeat(40) +
        '<p>Nội dung thật.</p>' +
        '<div></div><div>\n</div><div>\t</div>'.repeat(20) +
        '<p>Đoạn cuối.</p></body></html>',
    );
  },
  '/huge.pdf': (res) => {
    // Declares far more than any document ceiling and sends nothing: the refusal
    // must happen on the header, before a byte is read.
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': 400 * 1024 * 1024 });
    res.end(Buffer.alloc(16));
  },
  '/endless.txt': (res) => {
    // Chunked, so there is no `content-length` to refuse on — the only thing
    // that stops this is the reader counting bytes as they arrive.
    res.writeHead(200, { 'content-type': 'text/plain' });
    const mb = Buffer.alloc(1024 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < 12) {
        sent += 1;
        if (!res.write(mb)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  },
};

// What reached the other origin after a redirect: its headers and its body.
const arrived = [];
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  // 127.0.0.1 and localhost are different origins on the same server.
  const other = `http://localhost:${server.address().port}`;
  if (path === '/moved-get') return res.writeHead(302, { Location: `${other}/landing` }).end();
  if (path === '/moved-post') return res.writeHead(307, { Location: `${other}/landing` }).end();
  if (path === '/landing') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      arrived.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('landed');
    });
    return;
  }
  const route = routes[path];
  if (!route) return res.writeHead(404).end();
  route(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const { LIBRARY_IMPLEMENTATIONS } = await import('../server/tools/library.js');

const failure = async (promise) => promise.then(() => null, (err) => err.message);

try {
  section('a PDF too big for the old ceiling is read, not refused');
  {
    const out = await webFetch({ url: `${base}/exam.pdf` });
    check('it is over the 8MB page ceiling to begin with', bigPdf.length > 8 * 1024 * 1024, `${bigPdf.length} bytes`);
    check('the words inside come back', out.includes('Dieu uoc quoc te'), out.slice(0, 200));
    check('the header says it was a PDF and how long', /\(PDF, 1 page\)/.test(out), out.split('\n')[0]);
    check('and it is still wrapped as untrusted text', out.includes('untrusted'), out.slice(0, 160));
  }

  section('the PDF engine brings its own worker');
  {
    /*
     * pdfjs parses in a worker and falls back to running the same code on this
     * thread when there is no `Worker` — which in Node is always. That fallback
     * reached the worker module with `import(this.workerSrc)`, a *variable*
     * specifier no bundler can follow, so Vercel shipped pdf.mjs without
     * pdf.worker.mjs and every PDF on the deployment failed with "Setting up
     * fake worker failed". `globalThis.pdfjsWorker` is checked first, so
     * handing over a module imported by name both traces and skips it.
     */
    check('it was handed over rather than imported by path', typeof globalThis.pdfjsWorker?.WorkerMessageHandler === 'function');
  }

  section('a Word document behind a link is read the same way an attachment is');
  {
    const out = await webFetch({ url: `${base}/report.docx` });
    check('its text comes back', out.includes('Revenue rose by 12%'), out.slice(0, 300));
    check('named as a docx', out.includes('(docx)'), out.split('\n')[0]);
  }

  section('bytes that are not readable are refused out loud');
  {
    const message = await failure(webFetch({ url: `${base}/photo.png` }));
    check('a picture is not pasted in as mojibake', !!message, String(message));
    check('and the refusal says what to do instead', /download_file/.test(message || ''), String(message));
  }

  section('an ordinary page still arrives as words');
  {
    const out = await webFetch({ url: `${base}/page.html` });
    check('the markup is stripped', !out.includes('<h1>') && out.includes('Tiêu đề'), out.slice(0, 200));
    check('and the stylesheet is not treated as prose', !out.includes('b{}'), out.slice(0, 200));
  }

  section('http_request: a key and a body stay with the site they were meant for');
  {
    const call = LIBRARY_IMPLEMENTATIONS.http_request;
    arrived.length = 0;
    const got = await call({ method: 'GET', url: `${base}/moved-get`, headers: { 'X-API-Key': 'k-123', Authorization: 'Bearer t', 'X-Trace': 'keep' } });
    const hop = arrived[0]?.headers || {};
    check('a GET follows the redirect', /landed/.test(got), got.slice(0, 120));
    check('  without the API key', !hop['x-api-key'] && !hop.authorization, JSON.stringify(hop));
    check('  and keeps what is not a credential', hop['x-trace'] === 'keep');

    arrived.length = 0;
    const post = await call({ method: 'POST', url: `${base}/moved-post`, json: { secret: 'payload' } });
    check('a POST body is not resent to another origin', arrived.length === 0, JSON.stringify(arrived));
    check('  and the model is told where it pointed', /Redirected to http:\/\/localhost:\d+\/landing/.test(post), post.slice(0, 200));

    const endless = await call({ method: 'GET', url: `${base}/endless.txt` });
    check('an endless body is read to a cap, not to the end', endless.length < 50_000, String(endless.length));
  }

  section('a size nothing could hold is still refused before it is read');
  {
    const message = await failure(webFetch({ url: `${base}/huge.pdf` }));
    check('refused on the declared length', /too large to read/.test(message || ''), String(message));
  }

  section('a response that never declares its size is cut, not swallowed whole');
  {
    const out = await webFetch({ url: `${base}/endless.txt`, max_chars: 500 });
    check('it returns rather than running the process out of memory', typeof out === 'string');
    check('and says it stopped short of the whole thing', /kept sending past/.test(out), out.slice(-240));
    // A bare "[truncated]" left the model with no idea that asking again would
    // get it more, so it answered from the first slice or gave up.
    check('and how to read the rest', /larger max_chars/.test(out), out.slice(-160));
  }
  section('a page built out of empty divs does not arrive as empty lines');
  {
    const out = await webFetch({ url: `${base}/spacer.html` });
    const body = out.slice(out.indexOf('<untrusted'));
    const lines = body.split('\n');
    const blanks = lines.filter((line) => !line.trim()).length;

    check('the words are all there', /Tiêu đề[\s\S]*Nội dung thật[\s\S]*Đoạn cuối/.test(body), body.slice(0, 120));

    /**
     * The bug this is here for.
     *
     * `[ \t]+ → ' '` ran before `\n{3,} → '\n\n'`, so a blank line's worth of
     * markup became `\n \n` — a space between the newlines, which is exactly
     * what stopped the collapse matching. Sixty empty divs came through as
     * sixty blank lines, into the prompt, charged on the fetch and again on
     * every later step of the turn.
     */
    check('no line is whitespace pretending to be content', !/\n[ \t]+\n/.test(body), JSON.stringify(body.slice(0, 200)));
    check('and at most one blank line separates paragraphs', blanks <= 3, `${blanks} blank lines of ${lines.length}`);

    // Sixty empty divs is about 700 characters of markup. What survives should
    // be the three sentences and their separators, and nothing else.
    check('so the whole thing is short', body.length < 260, `${body.length} chars`);
  }
} finally {
  server.close();
}

/* ── youtube_transcript: the parts that need no network ─────────
 *
 * `web_fetch` on a YouTube link returns the page's chrome and none of the
 * speech, so the assistant's honest answer was "paste the transcript yourself".
 * The new tool reads the caption track instead. Its three risky pieces are pure
 * functions on purpose, so they can be checked here against the exact shapes
 * YouTube actually serves rather than against a mock of them.
 * ─────────────────────────────────────────────────────────────── */

const { youtubeId, transcriptFromSegments } = await import('../server/tools/cloud.js');

section('the video id, out of whatever was pasted');
{
  const id = 'dQw4w9WgXcQ';
  check('a watch URL', youtubeId(`https://www.youtube.com/watch?v=${id}`) === id);
  check('with other parameters on it', youtubeId(`https://www.youtube.com/watch?v=${id}&t=42s&list=PL1`) === id);
  check('a share link', youtubeId(`https://youtu.be/${id}?si=abc`) === id);
  check('a Shorts link', youtubeId(`https://www.youtube.com/shorts/${id}`) === id);
  check('an embed', youtubeId(`https://www.youtube-nocookie.com/embed/${id}`) === id);
  check('the phone host', youtubeId(`https://m.youtube.com/watch?v=${id}`) === id);
  check('the bare id, which is what people paste after being asked once', youtubeId(id) === id);

  // Refusing clearly matters as much as parsing: the tool's error names what a
  // usable input looks like, and it can only do that if it knows it has one.
  check('not a Vimeo link', youtubeId('https://vimeo.com/123456') === null);
  check('not a lookalike host', youtubeId('https://notyoutube.com/watch?v=dQw4w9WgXcQ') === null);
  check('not a javascript: URL', youtubeId('javascript:alert(1)') === null);
  check('not prose', youtubeId('summarise that video for me') === null);
  check('and an id of the wrong length is not one', youtubeId('https://youtu.be/tooshort') === null);
}

section('caption segments, as prose with positions in it');
{
  // Supadata's shape: offsets in milliseconds, one segment per spoken chunk.
  const out = transcriptFromSegments([
    { text: 'chênh lệch lãi suất', offset: 0, duration: 3000 },
    { text: 'and inflation', offset: 3500, duration: 3000 },
    { text: '   ', offset: 50_200, duration: 3000 },
    { text: 'much later', offset: 61_700, duration: 3000 },
    { text: 'later still', offset: 200_000, duration: 3000 },
  ]);

  check('Vietnamese comes through untouched', out.includes('chênh lệch lãi suất'), out);
  check('the first segment is stamped', out.startsWith('[0:00]'), out.slice(0, 20));
  // Not one stamp per segment — that doubles the size of a transcript and makes
  // it read as a subtitle file — but often enough that a claim can be pointed at.
  check('a segment moments later shares that stamp', !out.includes('[0:03]'), out);
  check('a segment a minute on gets its own', out.includes('[1:01]'), out);
  check('and minutes past the hour mark read as minutes', out.includes('[3:20]'), out);
  check('an empty segment contributes nothing', !/\[0:50\]/.test(out), out);

  // The shapes an API returns on a bad day. None of them should produce a
  // transcript-looking string, because the tool reads emptiness as "this video
  // has no captions" and says so instead of retrying.
  check('no segments yields nothing', transcriptFromSegments([]) === '');
  check('null yields nothing', transcriptFromSegments(null) === '');
  check('and a segment with no text yields nothing', transcriptFromSegments([{ offset: 0 }]) === '');
}

section('the video tool is hidden until Supadata is linked');
{
  const { availableTools } = await import('../server/tools/definitions.js');
  const named = (list) => list.some((t) => t.name === 'youtube_transcript');

  // The point of the connector. YouTube's own endpoint serves a server an empty
  // body, so an account with no key has no way at all to read a video — and a
  // tool offered in that state could only promise and fail.
  check(
    'an account with no connectors is not offered it',
    !named(availableTools({ context: 200_000, connected: [] })),
  );
  check(
    'an account with other connectors is not offered it either',
    !named(availableTools({ context: 200_000, connected: ['github', 'slack'] })),
  );
  check(
    'and linking Supadata is what reveals it',
    named(availableTools({ context: 200_000, connected: ['supadata'] })),
  );
}

console.log(
  failures === 0 ? '\n\x1b[32mweb_fetch reads pages and documents.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
