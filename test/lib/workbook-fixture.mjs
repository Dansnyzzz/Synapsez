/**
 * A workbook written by hand, with each thing a viewer has to show in it: fills, fonts
 * and borders, a merge, frozen panes, a shared formula, rich words, a number too wide
 * for its column, a hidden sheet, a chart with a title, and one on another sheet.
 */
import { writeZip } from '../../server/office/zip.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

const chart = (title) =>
  `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/>` +
  '<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Doanh thu</c:v></c:tx><c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numLit></c:val></c:ser>' +
  '<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="2"/></c:valAx></c:plotArea></c:chart></c:chartSpace>';
const drawing = (from, to) =>
  `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}"><xdr:twoCellAnchor><xdr:from><xdr:col>${from}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
  '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
  `<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${REL}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
const rels = (entries) =>
  `<Relationships xmlns="${PKG}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;

export function workbookFixture() {
  return writeZip([
    {
      name: '[Content_Types].xml',
      data:
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'xl/workbook.xml']]) },
    {
      name: 'xl/workbook.xml',
      data: `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Báo cáo" sheetId="1" r:id="rId1"/><sheet name="Ẩn" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Sheet thứ hai" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'worksheet', 'worksheets/sheet3.xml'], ['rId4', 'styles', 'styles.xml'], ['rId5', 'sharedStrings', 'sharedStrings.xml']]) },
    {
      name: 'xl/styles.xml',
      data:
        `<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>` +
        '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF0000FF"/><name val="Arial;background:url(http://evil)"/></font><font><i/><u/><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDA0DD"/></patternFill></fill></fills>' +
        '<borders count="2"><border/><border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="medium"><color rgb="FFFF0000"/></bottom></border></borders>' +
        '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
        '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>',
    },
    {
      name: 'xl/sharedStrings.xml',
      data: `<sst xmlns="${MAIN}"><si><t>Tiêu đề</t></si><si><t>Tổng</t></si><si><r><t>Chi phí </t></r><r><rPr><b/><color rgb="FFFF0000"/></rPr><t>nhiên liệu</t></r></si><si><t>Chữ dài chạy sang các ô trống bên cạnh như trong Excel</t></si><si><t>Gộp bốn cột</t></si><si><t>Một đoạn dài xuống dòng trong ô của nó vì ô này được đặt xuống dòng</t></si></sst>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1:F8"/><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
        '<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="3" width="12" customWidth="1"/><col min="6" max="6" width="3" customWidth="1"/></cols><sheetData>' +
        '<row r="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>1234567</v></c><c r="C2" s="2"><f>B2*2</f><v>2469134</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>3</v></c></row>' +
        '<row r="4"><c r="A4" s="3" t="s"><v>4</v></c></row>' +
        '<row r="5" ht="60" customHeight="1"><c r="A5" s="4" t="s"><v>5</v></c></row>' +
        '<row r="6"><c r="A6"><f t="shared" ref="A6:A8" si="0">B2+1</f><v>1234568</v></c><c r="F6"><v>123456789</v></c></row>' +
        '<row r="7"><c r="A7"><f t="shared" si="0"/><v>0</v></c></row>' +
        '<row r="8"><c r="A8"><f t="shared" si="0"/><v>0</v></c></row>' +
        '</sheetData><mergeCells count="1"><mergeCell ref="A4:D4"/></mergeCells><drawing r:id="rId1"/></worksheet>',
    },
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels([['rId1', 'drawing', '../drawings/drawing1.xml']]) },
    { name: 'xl/drawings/drawing1.xml', data: drawing(1, 5) },
    { name: 'xl/drawings/_rels/drawing1.xml.rels', data: rels([['rId1', 'chart', '../charts/chart1.xml']]) },
    { name: 'xl/charts/chart1.xml', data: chart('Doanh thu theo nhóm') },
    { name: 'xl/worksheets/sheet2.xml', data: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ẩn</t></is></c></row></sheetData></worksheet>` },
    {
      name: 'xl/worksheets/sheet3.xml',
      data: `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Ở sheet hai</t></is></c></row></sheetData><drawing r:id="rId1"/></worksheet>`,
    },
    { name: 'xl/worksheets/_rels/sheet3.xml.rels', data: rels([['rId1', 'drawing', '../drawings/drawing2.xml']]) },
    { name: 'xl/drawings/drawing2.xml', data: drawing(0, 3) },
    { name: 'xl/drawings/_rels/drawing2.xml.rels', data: rels([['rId1', 'chart', '../charts/chart2.xml']]) },
    { name: 'xl/charts/chart2.xml', data: chart('Biểu đồ sheet hai') },
  ]);
}
