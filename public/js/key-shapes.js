/**
 * What each issuer's secrets look like, in one place for both sides: the server takes a
 * secret pasted in the wrong box where it belongs (server/keyIntake.js), and the guide uses
 * the same shapes to tell a finished key from half of one while it is being typed — a check
 * costs a request against an hourly limit the connectors share, so it must not be spent on
 * every pause in the middle of a key.
 */

/**
 * Provider keys. The first that fits wins.
 * @type {Array<[string, RegExp]>}
 */
export const PROVIDER_SHAPES = [
  ['openrouter', /^sk-or-(v\d+-)?\S{6,}$/],
  ['orcarouter', /^sk-orca-\S{6,}$/],
  ['anthropic', /^sk-ant-\S{8,}$/],
  // AI Studio issues only the AQ. kind now; the AIza kind is still in use.
  ['google', /^(AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_-]{30,})$/],
  ['openai', /^sk-(proj|svcacct|admin)-\S{8,}$/],
  ['openai', /^sk-[A-Za-z0-9]{16,}T3BlbkFJ[A-Za-z0-9]{16,}$/],
];

/**
 * Connector tokens.
 * @type {Array<[string, RegExp]>}
 */
export const SERVICE_SHAPES = [
  ['github', /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/],
  ['notion', /^(ntn_|secret_)[A-Za-z0-9]{20,}$/],
  ['slack', /^xox[abpe]-[A-Za-z0-9-]{10,}$/],
  ['telegram', /^\d{5,12}:[A-Za-z0-9_-]{30,}$/],
  ['supadata', /^sd_[A-Za-z0-9]{10,}$/],
  ['meta_page', /^EAA[A-Za-z0-9]{20,}$/],
];

/**
 * Whole enough to spend a check on while it is still being typed. A shape alone is too little:
 * OpenRouter's matches from six characters on, and every check uses one of the twenty an hour
 * that connectors share. Real keys are far longer than 30, so a partial one waits for Enter.
 */
export const looksWhole = (text) => String(text || '').trim().length >= 30 && looksLikeKey(text);

/** True when the text is whole in the shape of some key or token. */
export const looksLikeKey = (text) => [...PROVIDER_SHAPES, ...SERVICE_SHAPES].some(([, shape]) => shape.test(String(text || '').trim()));
