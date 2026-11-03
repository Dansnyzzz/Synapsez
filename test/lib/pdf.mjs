/**
 * A valid one-page PDF, built by hand, as the base64 an attachment is stored as.
 *
 * A real fixture would be a binary blob in the repository that nobody can read
 * a diff of; this is a few lines of the format itself, and it exercises the
 * same parser. Vietnamese in a subset font — the case that started this — was
 * checked against a Chromium-printed document, which needs a browser and so
 * does not belong in the suite that has to stay fast.
 */
export function tinyPdf(line = 'Hello from a test PDF') {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null, // the content stream, built below
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  const stream = `BT /F1 14 Tf 20 120 Td (${line.replace(/([()\\])/g, '\\$1')}) Tj ET`;
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}
