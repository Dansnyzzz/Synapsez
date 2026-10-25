/**
 * The look of a document the assistant makes: one palette for Word, Excel and
 * PowerPoint alike, picked from what the document is about.
 *
 * The owner's 2026-10-25 round: the files "just had text added" — white slides
 * with a title and bullets, a Word file in black Calibri, a grey header row.
 * They wanted the design done for them, "everything automated down to the
 * finished file". So every document now has a palette, chosen from its topic
 * when the model names none: money reads navy, health teal, the environment
 * green. A person can still name one (`theme` on `create_file`).
 *
 * Colours are six-digit hex without the `#`, the way OOXML writes them.
 */

/**
 * @typedef {{ name: string, primary: string, secondary: string, accent: string,
 *   soft: string, softer: string, dark: string, ink: string, muted: string, line: string }} Palette
 *
 *   primary    titles, a header row, a cover's ground
 *   secondary  second-level headings, a gradient's far end
 *   accent     bars, bullets, the figure on a KPI card — the one bright colour
 *   soft       a tinted band (a banded row, a card)
 *   softer     the lightest tint (a slide's ground)
 *   dark       the deepest ground (a cover, a section slide)
 *   ink        body text on white
 *   muted      captions, footers
 *   line       hairlines
 */

/** @type {Record<string, Palette>} */
export const THEMES = {
  ocean: { name: 'Ocean', primary: '1F4E79', secondary: '2E75B6', accent: '00A3E0', soft: 'E7F0F9', softer: 'F5F9FD', dark: '0E2A47', ink: '1F2933', muted: '5B6B7A', line: 'D5DEE8' },
  emerald: { name: 'Emerald', primary: '0F5C3E', secondary: '1E8A5A', accent: '2BB673', soft: 'E6F4EC', softer: 'F4FAF6', dark: '083723', ink: '1D2A24', muted: '587066', line: 'D3E5DA' },
  sunset: { name: 'Sunset', primary: 'A23B12', secondary: 'D9561A', accent: 'F59E0B', soft: 'FDEFE5', softer: 'FFF8F2', dark: '561C06', ink: '2B211C', muted: '76665C', line: 'EBDACD' },
  violet: { name: 'Violet', primary: '3F2A8C', secondary: '6246D8', accent: 'E0458C', soft: 'EEEAFB', softer: 'F8F6FE', dark: '1F1350', ink: '221F2E', muted: '67637A', line: 'DEDAF0' },
  teal: { name: 'Teal', primary: '0B5563', secondary: '0E7C86', accent: '2EC4B6', soft: 'E4F4F5', softer: 'F3FAFA', dark: '052F37', ink: '1B2A2D', muted: '597073', line: 'D0E4E6' },
  crimson: { name: 'Crimson', primary: '8E1537', secondary: 'C8234F', accent: 'FF7A59', soft: 'FBE9EE', softer: 'FEF6F8', dark: '4A0A1C', ink: '2B1D21', muted: '7A6268', line: 'EED6DD' },
  slate: { name: 'Slate', primary: '1F2937', secondary: '3B4A5E', accent: 'F2A900', soft: 'EEF1F5', softer: 'F7F8FA', dark: '0F1620', ink: '1F2933', muted: '5F6B7A', line: 'D8DEE6' },
};

export const THEME_NAMES = Object.keys(THEMES);

/**
 * Words that say what a document is about, in Vietnamese and English, and the
 * palette each reads best in. The first whose words appear most wins; a tie
 * goes to the earlier row. Accents are kept: "tài chính" is not "tai chinh".
 */
const TOPICS = [
  ['ocean', /tài chính|ngân hàng|đầu tư|doanh thu|lợi nhuận|kế toán|ngân sách|chứng khoán|cổ phiếu|thuế|báo giá|hoá đơn|hóa đơn|finance|financial|bank|invest|revenue|profit|budget|accounting|stock|tax|invoice|quotation|kpi/giu],
  ['emerald', /môi trường|xanh|năng lượng|điện mặt trời|xe điện|bền vững|khí hậu|nông nghiệp|carbon|environment|green|energy|solar|electric vehicle|\bev\b|sustainab|climate|agricultur|esg/giu],
  ['teal', /y tế|sức khỏe|sức khoẻ|bệnh viện|bệnh nhân|dược|điều dưỡng|dinh dưỡng|health|medical|hospital|patient|pharma|clinic|nutrition|wellness/giu],
  ['violet', /công nghệ|trí tuệ nhân tạo|\bai\b|phần mềm|dữ liệu|chuyển đổi số|số hoá|số hóa|ứng dụng|lập trình|blockchain|technology|software|data|digital|machine learning|cloud|startup|saas|app\b/giu],
  ['sunset', /giáo dục|học sinh|sinh viên|đào tạo|khóa học|khoá học|bài giảng|trường|du lịch|ẩm thực|sự kiện|education|student|training|course|lesson|school|university|travel|tourism|food|event/giu],
  ['crimson', /marketing|thương hiệu|quảng cáo|bán hàng|khách hàng|chiến dịch|truyền thông|mạng xã hội|brand|advertis|sales|customer|campaign|social media|growth|crm/giu],
  ['slate', /hợp đồng|pháp lý|luật|quy định|chính sách|biên bản|nội quy|contract|legal|law|policy|regulation|compliance|minutes|agreement/giu],
];

/**
 * The palette for a document: the one asked for by name, else the one its
 * topic reads best in, else ocean.
 *
 * @param {string|null|undefined} asked
 * @param {string} text  the title and the content, for the topic
 * @returns {Palette}
 */
export function pickTheme(asked, text = '') {
  const named = String(asked || '').trim().toLowerCase();
  if (named && THEMES[named]) return THEMES[named];
  const sample = String(text || '').slice(0, 20_000).toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [name, words] of TOPICS) {
    const score = (sample.match(words) || []).length;
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return THEMES[best || 'ocean'];
}

/** A colour mixed toward white by `amount` (0–1) — for tints the palette does not list. */
export function tint(hex, amount) {
  const n = parseInt(hex, 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase();
}

/** Whether text is mostly Vietnamese — for the language a document declares, so spelling is checked in it. */
export const looksVietnamese = (text) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(String(text || '').slice(0, 4000));
