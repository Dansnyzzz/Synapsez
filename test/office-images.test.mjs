/**
 * Pictures out of a Word document.
 *
 * A report full of figures used to preview as the word "[image]" thirty times:
 * the reader counted pictures and threw them away. This builds a .docx with a
 * real picture in it, built by hand at the ZIP level — the
 * writer here does not emit images, so the only honest test is a package
 * shaped the way Word shapes one.
 */
import { writeZip, openZip } from '../server/office/zip.js';
import { readDocx } from '../server/office/docx.js';
import { blocksToHtml } from '../server/office/blocks.js';

let bad = 0;
const check = (what, ok, note = '') => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${what}${note ? ` — ${note}` : ''}`);
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:v="urn:schemas-microsoft-com:vml">
  <w:body>
    <w:p><w:r><w:t>Trước hình.</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline>
      <wp:docPr id="1" name="Figure 1" descr="Biểu đồ doanh thu"/>
      <a:graphic><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
      </pic:pic></a:graphicData></a:graphic>
    </wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:t>Hình 1: biểu đồ.</w:t></w:r></w:p>
    <w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId6" title="Ảnh cũ"/></v:shape></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline>
      <wp:docPr id="2" name="Figure 2"/>
      <a:graphic><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
      </pic:pic></a:graphicData></a:graphic>
    </wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline>
      <a:graphic><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:blipFill><a:blip r:embed="rId9"/></pic:blipFill>
      </pic:pic></a:graphicData></a:graphic>
    </wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:t>Sau hình.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.jpeg"/>
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/remote.png" TargetMode="External"/>
</Relationships>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const buffer = writeZip([
  { name: '[Content_Types].xml', data: Buffer.from(types, 'utf8') },
  { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
  { name: 'word/document.xml', data: Buffer.from(doc, 'utf8') },
  { name: 'word/_rels/document.xml.rels', data: Buffer.from(rels, 'utf8') },
  { name: 'word/media/image1.png', data: PNG },
  { name: 'word/media/image2.jpeg', data: PNG },
]);

console.log('\n\x1b[1mpictures out of a .docx\x1b[0m');
const read = readDocx(buffer);

check('the package reads', !!read.blocks.length, `${read.blocks.length} blocks`);
check('the words either side survive', /Trước hình/.test(read.text) && /Sau hình/.test(read.text));

const images = read.blocks.filter((b) => b.type === 'image');
check('three pictures were found', images.length === 3, `${images.length}: ${JSON.stringify(images)}`);
check('the modern drawing markup', images.some((i) => i.alt === 'Biểu đồ doanh thu'), images.map((i) => i.alt).join(' | '));
check('and the Word 97 shape markup', images.some((i) => i.alt === 'Ảnh cũ'));

check('the same file used twice is stored once', read.media.length === 2, `${read.media.length} parts: ${read.media.map((m) => m.part).join(', ')}`);
check('and both references point at it', images.filter((i) => i.index === 0).length === 2, JSON.stringify(images.map((i) => i.index)));
check('with real bytes', read.media[0].data.equals(PNG), `${read.media[0].data.length} bytes`);
check('and the right content type', read.media[0].contentType === 'image/png' && read.media[1].contentType === 'image/jpeg',
  read.media.map((m) => m.contentType).join(', '));

// A picture whose bytes live on somebody else's server is not fetched.
check('an external picture is not followed', !read.media.some((m) => /example\.com/.test(m.part)), read.media.map((m) => m.part).join(', '));

check('the count reported matches', read.meta.images === 3, `${read.meta.images}`);

console.log('\n\x1b[1mand into the preview\x1b[0m');
const html = blocksToHtml(read.blocks, { mediaSrc: (i) => `/api/attachments/x/media/${i}` });
check('figures are drawn', (html.match(/<figure/g) || []).length === 3, html.slice(0, 200));
check('pointing at the route', /src="\/api\/attachments\/x\/media\/0"/.test(html));
check('with the caption as alt text', /alt="Biểu đồ doanh thu"/.test(html));
check('and a visible caption', /<figcaption>Biểu đồ doanh thu<\/figcaption>/.test(html));
check('lazily, so thirty figures do not all load at once', /loading="lazy"/.test(html));

const noSrc = blocksToHtml(read.blocks);
check('without a way to serve them they degrade to captions', /figure__missing/.test(noSrc) && !/<img/.test(noSrc), noSrc.slice(0, 140));

// The alt text comes out of a stranger's document.
console.log('\n\x1b[1mand nothing from the document becomes markup\x1b[0m');
{
  const nasty = blocksToHtml([{ type: 'image', index: 0, alt: '"><script>alert(1)</script>' }], {
    mediaSrc: () => '"><script>alert(2)</script>',
  });
  check('a tag in the alt text is escaped', !/<script>/.test(nasty), nasty);
  check('and so is one in the src', !nasty.includes('><script'), nasty.slice(0, 120));
}

// Round trip through the ZIP writer/reader, to be sure the fixture is real.
check('the fixture is a genuine package', openZip(buffer).has('word/media/image1.png'));

// An Office file too big to send goes without its pictures (public/js/shrink.js).
// What the server reads from the slimmed copy has to be the same document.
console.log('\n\x1b[1man oversized .docx is sent without its pictures\x1b[0m');
{
  const { slimOfficeBytes } = await import('../public/js/shrink.js');
  const { randomBytes } = await import('node:crypto');
  // A photo is incompressible, which is exactly why these files are big.
  const heavy = writeZip([
    { name: '[Content_Types].xml', data: Buffer.from(types, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(doc, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/media/image1.png', data: randomBytes(4 * 1024 * 1024) },
    { name: 'word/media/image2.jpeg', data: randomBytes(2 * 1024 * 1024) },
    { name: 'docProps/thumbnail.jpeg', data: randomBytes(64 * 1024) },
  ]);
  const slim = slimOfficeBytes(heavy);
  check('it slims', !!slim, 'returned null');
  check('the pictures and the thumbnail are what went', slim?.dropped === 3, String(slim?.dropped));
  check('from megabytes to kilobytes', slim && slim.bytes.length < 20_000, `${heavy.length} → ${slim?.bytes.length}`);

  const zip = openZip(Buffer.from(slim.bytes));
  check('still a package the server opens', zip.has('word/document.xml') && !zip.has('word/media/image1.png'), zip.names.join(', '));
  const reread = readDocx(Buffer.from(slim.bytes));
  check('and every word is still there', /Trước hình/.test(reread.text) && /Hình 1: biểu đồ/.test(reread.text) && /Sau hình/.test(reread.text), reread.text.slice(0, 120));
  check('a missing picture is skipped, not an error', reread.media.length === 0);

  check('a file with nothing heavy in it is left alone', slimOfficeBytes(slimOfficeBytes(heavy).bytes) === null);
  check('and a file that is not a zip is refused, not mangled', slimOfficeBytes(Buffer.from('not a zip at all')) === null);
}

console.log(bad ? `\n\x1b[31m${bad} problem(s).\x1b[0m\n` : '\n\x1b[32mAll good.\x1b[0m\n');
process.exit(bad ? 1 : 0);
