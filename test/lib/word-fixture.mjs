/**
 * A .docx shaped the way Word itself writes one, not the way this app's generator
 * does: everything inherited through styles and a table style's conditional parts,
 * compatibility mode 15, a floating text box, a square-wrapped shape, list numbering
 * from numbering.xml, a footer with a PAGE field. Checked once by opening it in real
 * Word (2026-11-05), so a reader tested against it is tested against a real shape.
 */
import { writeZip } from '../../server/office/zip.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The colours the test looks for on the page. */
export const FIXTURE = { heading: '0F4761', tableHead: '156082', band: 'C1E4F5', box: 'FFD966', square: '70AD47', red: 'C00000' };

const THEME = `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0E2841"/></a:dk2><a:lt2><a:srgbClr val="E8E8E8"/></a:lt2><a:accent1><a:srgbClr val="156082"/></a:accent1><a:accent2><a:srgbClr val="E97132"/></a:accent2><a:accent3><a:srgbClr val="196B24"/></a:accent3><a:accent4><a:srgbClr val="0F9ED5"/></a:accent4><a:accent5><a:srgbClr val="A02B93"/></a:accent5><a:accent6><a:srgbClr val="4EA72E"/></a:accent6><a:hlink><a:srgbClr val="467886"/></a:hlink><a:folHlink><a:srgbClr val="96607D"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const STYLES = `${HEAD}<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="80"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="0F4761" w:themeColor="accent1" w:themeShade="BF"/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="GridTable4"><w:name w:val="Grid Table 4 Accent 1"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblStyleRowBandSize w:val="1"/><w:tblStyleColBandSize w:val="1"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="45B0E1" w:themeColor="accent1" w:themeTint="99"/><w:left w:val="single" w:sz="4" w:space="0" w:color="45B0E1"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="45B0E1"/><w:right w:val="single" w:sz="4" w:space="0" w:color="45B0E1"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="45B0E1"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="45B0E1"/></w:tblBorders></w:tblPr>
<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/><w:color w:val="FFFFFF" w:themeColor="background1"/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="156082" w:themeFill="accent1"/></w:tcPr></w:tblStylePr>
<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="C1E4F5" w:themeFill="accent1" w:themeFillTint="33"/></w:tcPr></w:tblStylePr>
</w:style>
</w:styles>`;

const NUMBERING = `${HEAD}<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const SETTINGS = `${HEAD}<w:settings ${W}><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><w:clrSchemeMapping w:bg1="light1" w:t1="dark1" w:bg2="light2" w:t2="dark2" w:accent1="accent1" w:accent2="accent2" w:accent3="accent3" w:accent4="accent4" w:accent5="accent5" w:accent6="accent6" w:hyperlink="hyperlink" w:followedHyperlink="followedHyperlink"/></w:settings>`;

const run = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (text, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${run(text)}</w:p>`;

/** An anchored shape, its fill and words, wrapped as asked. */
function floating(id, fill, wrap, xPt, yPt, wPt, hPt, words) {
  const emu = (v) => Math.round(v * 12700);
  const body = words ? `<wps:txbx><w:txbxContent>${para(words)}</w:txbxContent></wps:txbx>` : '';
  // How Word itself writes a shape: older readers take the fallback, and there is none here.
  return `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="${id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(xPt)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(yPt)}</wp:posOffset></wp:positionV><wp:extent cx="${emu(wPt)}" cy="${emu(hPt)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}<wp:docPr id="${id}" name="Shape ${id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(wPt)}" cy="${emu(hPt)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></wps:spPr>${body}<wps:bodyPr rot="0" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r>`;
}

const LONG = 'This paragraph is long enough to wrap across more than one line of the page, so that where its lines break can be compared with what Word does with it. ';

const cell = (text, w) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${para(text)}</w:tc>`;

function document() {
  const rows = [['Provider', 'Tokens', 'Cost'], ['OpenRouter', '120', '1,250.50'], ['OrcaRouter', '87', '640.00'], ['Gemini', '45', '310.25']]
    .map((row, i) => `<w:tr>${i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${row.map((text) => cell(text, 3009)).join('')}</w:tr>`).join('');
  const list = (text, numId, ilvl = 0) => para(text, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
  return `${HEAD}<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('A document Word wrote')}</w:p>
<w:p>${floating(1, FIXTURE.box, '<wp:wrapNone/>', 400, 90, 140, 40, 'A floating text box')}${run(LONG.repeat(3))}</w:p>
${list('First bullet', 1)}${list('Second bullet', 1)}${list('Numbered one', 2)}${list('Numbered two', 2)}${list('Lettered', 2, 1)}${list('Numbered three', 2)}
<w:tbl><w:tblPr><w:tblStyle w:val="GridTable4"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="3009"/><w:gridCol w:w="3009"/><w:gridCol w:w="3009"/></w:tblGrid>${rows}</w:tbl>
<w:p>${run('Red bold words', `<w:b/><w:color w:val="${FIXTURE.red}"/><w:sz w:val="32"/>`)}</w:p>
<w:p>${floating(2, FIXTURE.square, '<wp:wrapSquare wrapText="bothSides"/>', 72, 470, 120, 120, '')}${run(LONG.repeat(6))}</w:p>
<w:p><w:pPr><w:pageBreakBefore/></w:pPr>${run('The second page starts here.')}</w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rId10"/><w:footerReference w:type="default" r:id="rId11"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
}

const HEADER = `${HEAD}<w:hdr ${W}>${para('A header written by hand', '<w:jc w:val="right"/>')}</w:hdr>`;
const FOOTER = `${HEAD}<w:ftr ${W}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run('Page ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('9')}<w:r><w:fldChar w:fldCharType="end"/></w:r>${run(' of ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('9')}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;

const CONTENT_TYPES = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`;
const ROOT_RELS = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOC_RELS = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="${R}/settings" Target="settings.xml"/><Relationship Id="rId4" Type="${R}/theme" Target="theme/theme1.xml"/><Relationship Id="rId10" Type="${R}/header" Target="header1.xml"/><Relationship Id="rId11" Type="${R}/footer" Target="footer1.xml"/></Relationships>`;

/** The file, as a Buffer. */
export function wordFixture() {
  return writeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: document() },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
    { name: 'word/settings.xml', data: SETTINGS },
    { name: 'word/theme/theme1.xml', data: THEME },
    { name: 'word/header1.xml', data: HEADER },
    { name: 'word/footer1.xml', data: FOOTER },
  ]);
}
