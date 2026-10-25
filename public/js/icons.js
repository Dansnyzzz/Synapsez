/**
 * The small picture at the head of a finished tool line.
 *
 * A green tick on every line said "done" twelve times in a turn whose rows
 * were all done (owner, 2026-10-25: the reasoning's tick was "dư thừa" —
 * redundant — and so was every other). Claude heads each row with what kind of
 * thing it was instead: a globe for the web, a terminal for a command. A line
 * still running keeps its ring, and a failed one its red cross; this is only
 * for the lines that went well.
 *
 * Read off the tool's name, so a tool added tomorrow gets a fitting picture
 * without anybody coming back here, and the plain mark when nothing fits.
 */

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
  chat: svg('<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>'),
  terminal: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5M13 15h4"/>'),
  file: svg('<path d="M7 3.5h7l4.5 4.5v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/>'),
  image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>'),
  pin: svg('<path d="M12 20.5s-6.5-5.4-6.5-10.5a6.5 6.5 0 0 1 13 0c0 5.1-6.5 10.5-6.5 10.5z"/><circle cx="12" cy="10" r="2.3"/>'),
  calc: svg('<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 7.5h7M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 15.5h.01M12 15.5h.01M15.5 15.5h.01"/>'),
  chart: svg('<path d="M4 20h16M7 16.5V11M11.5 16.5V7M16 16.5v-4.5"/>'),
  mail: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  note: svg('<path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-4-6 4v-16a1 1 0 0 1 1-1z"/>'),
  window: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6 6.8h.01M8.5 6.8h.01"/>'),
  plug: svg('<path d="M9 3.5v4M15 3.5v4M7 7.5h10v3a5 5 0 0 1-10 0zM12 15.5v5"/>'),
  list: svg('<path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>'),
  spark: svg('<path d="M12 4l1.8 4.9L18.5 10.5l-4.7 1.7L12 17l-1.8-4.8L5.5 10.5l4.7-1.6z"/>'),
};

/**
 * Most specific first: "search_chats" is a conversation before it is a search.
 * @type {[RegExp, keyof typeof ICONS][]}
 */
const RULES = [
  [/^mcp__/, 'plug'],
  [/chats?\b|chats_|conversation/, 'chat'],
  [/image|photo|picture|look_at|qr|screenshot/, 'image'],
  [/place|map|route|direction/, 'pin'],
  [/calc|convert|date_calc|lunar|math|unit/, 'calc'],
  [/chart|widget|show_card|diagram/, 'chart'],
  [/mail|gmail|inbox/, 'mail'],
  [/schedule|workflow|remind|timer|cron/, 'clock'],
  [/memory|note/, 'note'],
  [/plan|todo/, 'list'],
  [/browser|desktop|screen/, 'window'],
  [/command|run_|sandbox|python|shell|process/, 'terminal'],
  [/file|doc|sheet|slide|pdf|publish|folder|dir/, 'file'],
  [/search|find|research|recall|lookup|grep|glob/, 'search'],
  [/web|fetch|url|http|feed|news|youtube|encyclopedia|wiki|market|sports|world|weather|exchange/, 'globe'],
];

/** The picture for a tool, by its name. */
export function toolIcon(name) {
  const n = String(name || '').toLowerCase();
  for (const [re, key] of RULES) if (re.test(n)) return ICONS[key];
  return ICONS.spark;
}

/** A finished line's mark: its tool's picture, or the red cross when it failed. */
export function doneMark(name, failed) {
  return failed ? '<span class="mark">✗</span>' : `<span class="mark mark--icon">${toolIcon(name)}</span>`;
}
