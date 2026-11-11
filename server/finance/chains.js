import { enabled } from './http.js';

export { enabled };

/**
 * Which sources answer which question, in order (spec §2).
 *
 * A table, so an order or a source removed is a data change: the first source
 * that answers is the one used, and a source that fails, is switched off
 * (`FIN_SOURCE_<NAME>=off`), stands aside or is over its ceiling passes the
 * question to the next. An entry may name one part of a source — `vndirect:dchart`
 * is VNDirect's chart host, `yahoo:v7` Yahoo's crumb-gated quote — and the part
 * before the colon is the source its kill switch, pacing and ceiling belong to.
 *
 * What is not here is deliberate. No paid API and no free key whose terms forbid
 * showing the data to the app's users (Finnhub, Tiingo, Twelve Data, Massive,
 * Alpaca, FMP, EODHD, Alpha Vantage); not SSI, MSN, BTMC, Stooq, Binance or TCBS
 * (research §1, owner 2026-11-10). And no Vietnamese `screen`: it would mean
 * crawling a whole market, which the safeguards forbid.
 */
export const CHAINS = {
  quote: { vn: ['vndirect', 'kbs', 'yahoo'], us: ['yahoo', 'yahoo:v7'], global: ['yahoo'], crypto: ['coingecko', 'yahoo'] },
  history: { vn: ['vndirect', 'vndirect:dchart', 'kbs', 'yahoo'], us: ['yahoo'], global: ['yahoo'], crypto: ['coingecko', 'yahoo'] },
  intraday: { vn: ['kbs', 'vndirect:dchart', 'yahoo'], us: ['yahoo'], global: ['yahoo'], crypto: ['coingecko'] },
  statements: { vn: ['vietcap', 'kbs'], us: ['sec', 'yahoo'], global: ['yahoo'] },
  ratios: { vn: ['vietcap', 'vndirect', 'kbs'], us: ['sec', 'yahoo'], global: ['yahoo'] },
  profile: { vn: ['vietcap', 'kbs'], us: ['sec', 'yahoo'], global: ['yahoo'], crypto: ['coingecko'] },
  events: { vn: ['vietcap', 'yahoo'], us: ['yahoo', 'sec'], global: ['yahoo'] },
  news: { vn: ['vietcap', 'kbs', 'yahoo'], us: ['yahoo'], global: ['yahoo'] },
  fund: { vn: ['fmarket', 'yahoo'], us: ['yahoo'], global: ['yahoo'] },
  options: { vn: ['vietcap'], us: ['yahoo'] },
  fx: { vn: ['vietcombank', 'frankfurter', 'ecb', 'erapi', 'yahoo'], us: ['frankfurter', 'ecb', 'erapi', 'yahoo'], global: ['frankfurter', 'ecb', 'erapi', 'yahoo'] },
  gold: { vn: ['sjc', 'yahoo'], us: ['yahoo'], global: ['yahoo'] },
  macro: { vn: ['worldbank', 'nso'], us: ['fred', 'worldbank'], global: ['worldbank', 'ecb'] },
  screen: { us: ['sec'] },
};

/** The chain for a question, less every source switched off. Empty when there is none. */
export function chainFor(kind, market) {
  return (CHAINS[kind]?.[market] || []).filter((name) => enabled(name));
}
