/*
 * The line icons a diagram's box may carry (owner, 2026-11-17: "flexible adaptive smartest
 * beautiful … chuyên nghiệp"): a small fixed set, so the model names one instead of drawing it,
 * and every icon is drawn the same way — on a 24-unit grid, 2 units of stroke with round ends,
 * no fill — so a dozen of them in one drawing read as one family.
 *
 * Drawn here rather than borrowed from an icon library: each is a few shapes, and owning them
 * keeps the set free of a licence and of a dependency. The renderer places one at 16 px,
 * inside a transformed group, which the drawing check reads as decoration rather than as a
 * box an arrow could end on.
 */

const round = (n) => Math.round(n * 100) / 100;

// A cog: eight teeth, each a flat top on the outer circle and a valley on the inner one.
function cog() {
  const R = 9;
  const r = 6.6;
  const at = (deg, radius) => {
    const a = (deg * Math.PI) / 180;
    return `${round(12 + radius * Math.cos(a))} ${round(12 + radius * Math.sin(a))}`;
  };
  let d = `M${at(-14, r)}`;
  for (let i = 0; i < 8; i += 1) {
    const t = i * 45;
    d += `L${at(t - 9, R)}A${R} ${R} 0 0 1 ${at(t + 9, R)}L${at(t + 14, r)}A${r} ${r} 0 0 1 ${at(t + 31, r)}`;
  }
  return `<path d="${d}z"/><circle cx="12" cy="12" r="3"/>`;
}

export const ICONS = Object.freeze({
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20.5a7 7 0 0 1 14 0"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  cache: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>',
  gear: cog(),
  document: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  chat: '<path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4.5 3.5V17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5M12 14.5V17"/>',
  chart: '<path d="M4 3.5v16.5h16.5M8.5 16v-4M13 16V8M17.5 16v-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5"/>',
  bolt: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
});

export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

// The grid every icon above is drawn on.
export const ICON_GRID = 24;
