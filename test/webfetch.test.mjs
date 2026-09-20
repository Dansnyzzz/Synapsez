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

const server = http.createServer((req, res) => {
  const route = routes[req.url.split('?')[0]];
  if (!route) return res.writeHead(404).end();
  route(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

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
} finally {
  server.close();
}

console.log(
  failures === 0 ? '\n\x1b[32mweb_fetch reads pages and documents.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
