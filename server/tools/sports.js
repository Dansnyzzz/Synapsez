import { untrusted } from './untrusted.js';

/**
 * Scores, fixtures and league tables, from TheSportsDB.
 *
 * Free with its public key, which is why it and not a richer feed: ESPN's
 * endpoints refuse data-centre addresses outright, and the rest want a paid
 * plan. The free key has limits worth saying out loud so the model does too —
 * one last result and one next fixture per team or league, and the top five
 * of a table — and a `THESPORTSDB_KEY` in the environment lifts them without a
 * code change.
 *
 * What comes back is two things: a line of text for the model, wrapped as
 * untrusted like any other outside data, and a `card` the browser draws as a
 * scores card — crests, scores, the table — so the answer can be looked at
 * rather than read out.
 */

const KEY = () => process.env.THESPORTSDB_KEY || '123';
const BASE = () => `https://www.thesportsdb.com/api/v1/json/${KEY()}`;
const UA = 'Synapsez/1.0 (+https://synapsez.vercel.app)';

/** The leagues people ask about most, so the common case costs one request, not two. */
const LEAGUES = {
  'premier league': 4328, epl: 4328, 'ngoại hạng anh': 4328, 'english premier league': 4328,
  'la liga': 4335, laliga: 4335,
  'serie a': 4332,
  bundesliga: 4331,
  'ligue 1': 4334,
  'champions league': 4480, ucl: 4480, 'cúp c1': 4480,
  'europa league': 4481,
  'v.league': 4803, 'v-league': 4803, 'v league': 4803, 'vleague': 4803, 'v.league 1': 4803,
  eredivisie: 4337,
  'primeira liga': 4344, 'liga portugal': 4344,
  mls: 4346,
  nba: 4387,
  nfl: 4391,
  mlb: 4424,
  nhl: 4380,
};

async function getJson(path) {
  const res = await fetch(`${BASE()}/${path}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  if (res.status === 429) throw new Error('TheSportsDB is rate-limiting (30 requests a minute on the free key). Try again shortly.');
  if (!res.ok) throw new Error(`TheSportsDB returned HTTP ${res.status}.`);
  const text = await res.text();
  // An unknown id answers with an empty body rather than an error.
  return text.trim() ? JSON.parse(text) : {};
}

const q = (s) => encodeURIComponent(String(s || '').trim());

/** One match, in the shape the card draws. */
export function matchOf(e) {
  const played = e.intHomeScore != null && e.intHomeScore !== '' && e.intAwayScore != null && e.intAwayScore !== '';
  return {
    league: e.strLeague || '',
    date: e.dateEvent || '',
    time: e.strTime ? String(e.strTime).slice(0, 5) : '',
    home: e.strHomeTeam || '',
    away: e.strAwayTeam || '',
    homeScore: played ? Number(e.intHomeScore) : null,
    awayScore: played ? Number(e.intAwayScore) : null,
    homeBadge: e.strHomeTeamBadge || '',
    awayBadge: e.strAwayTeamBadge || '',
    status: e.strStatus || (played ? 'FT' : ''),
    venue: e.strVenue || '',
    round: e.intRound ? String(e.intRound) : '',
  };
}

const matchLine = (m) =>
  `${m.date}${m.time ? ` ${m.time} UTC` : ''} · ${m.league}${m.round ? ` (round ${m.round})` : ''}: ${m.home} ` +
  `${m.homeScore == null ? 'vs' : `${m.homeScore}–${m.awayScore}`} ${m.away}${m.status && m.homeScore != null ? ` [${m.status}]` : ''}` +
  `${m.venue ? ` @ ${m.venue}` : ''}`;

async function findTeam(name) {
  const data = await getJson(`searchteams.php?t=${q(name)}`);
  const team = data?.teams?.[0];
  if (!team) throw new Error(`No team called "${name}" was found on TheSportsDB. Try its English name, e.g. "Manchester United".`);
  return team;
}

async function leagueId(name) {
  const text = String(name || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const known = LEAGUES[text.toLowerCase()];
  if (known) return known;
  throw new Error(
    `"${text}" is not a league this knows by name. Use one of: Premier League, La Liga, Serie A, Bundesliga, ` +
      'Ligue 1, Champions League, Europa League, V.League, Eredivisie, MLS, NBA, NFL, MLB, NHL — or its TheSportsDB id.',
  );
}

async function teamReport(name) {
  const team = await findTeam(name);
  const [last, next] = await Promise.all([
    getJson(`eventslast.php?id=${team.idTeam}`).catch(() => ({})),
    getJson(`eventsnext.php?id=${team.idTeam}`).catch(() => ({})),
  ]);
  const results = (last?.results || []).map(matchOf);
  const fixtures = (next?.events || []).map(matchOf);
  const lines = [
    `${team.strTeam} — ${team.strLeague || team.strSport}${team.strStadium ? `, ${team.strStadium}` : ''}${team.strCountry ? ` (${team.strCountry})` : ''}.`,
    results.length ? `Last result${results.length > 1 ? 's' : ''}:\n${results.map((m) => `- ${matchLine(m)}`).join('\n')}` : 'No recent result listed.',
    fixtures.length ? `Next:\n${fixtures.map((m) => `- ${matchLine(m)}`).join('\n')}` : 'No upcoming fixture listed.',
  ];
  return {
    text: lines.join('\n'),
    card: {
      type: 'scores',
      title: team.strTeam,
      subtitle: team.strLeague || team.strSport || '',
      badge: team.strBadge || '',
      sections: [
        ...(results.length ? [{ heading: 'last', matches: results }] : []),
        ...(fixtures.length ? [{ heading: 'next', matches: fixtures }] : []),
      ],
    },
  };
}

async function leagueReport(name) {
  const id = await leagueId(name);
  const info = (await getJson(`lookupleague.php?id=${id}`))?.leagues?.[0];
  if (!info) throw new Error(`No league with id ${id} on TheSportsDB.`);
  const season = info.strCurrentSeason;
  /** @type {[any, any, any]} */
  const [table, past, next] = await Promise.all([
    season ? getJson(`lookuptable.php?l=${id}&s=${q(season)}`).catch(() => ({})) : {},
    getJson(`eventspastleague.php?id=${id}`).catch(() => ({})),
    getJson(`eventsnextleague.php?id=${id}`).catch(() => ({})),
  ]);
  const rows = (table?.table || []).map((r) => ({
    rank: Number(r.intRank),
    team: r.strTeam,
    badge: String(r.strBadge || '').replace(/\/tiny$/, ''),
    played: Number(r.intPlayed),
    won: Number(r.intWin),
    drawn: Number(r.intDraw),
    lost: Number(r.intLoss),
    gd: Number(r.intGoalDifference),
    points: Number(r.intPoints),
    form: r.strForm || '',
  }));
  const results = (past?.events || []).map(matchOf);
  const fixtures = (next?.events || []).map(matchOf);
  const lines = [
    `${info.strLeague}, season ${season || '?'}.`,
    rows.length
      ? `Table (top ${rows.length}${KEY() === '123' ? ' — the free feed lists only the top five' : ''}):\n` +
        rows.map((r) => `${r.rank}. ${r.team} — ${r.points} pts, P${r.played} W${r.won} D${r.drawn} L${r.lost}, GD ${r.gd}`).join('\n')
      : 'No table for this season yet.',
    results.length ? `Latest:\n${results.map((m) => `- ${matchLine(m)}`).join('\n')}` : '',
    fixtures.length ? `Next:\n${fixtures.map((m) => `- ${matchLine(m)}`).join('\n')}` : '',
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    card: {
      type: 'scores',
      title: info.strLeague,
      subtitle: season ? `${season}` : '',
      badge: info.strBadge || '',
      table: rows,
      sections: [
        ...(results.length ? [{ heading: 'last', matches: results }] : []),
        ...(fixtures.length ? [{ heading: 'next', matches: fixtures }] : []),
      ],
    },
  };
}

async function dayReport(date, sport) {
  const day = String(date || '').trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('date is YYYY-MM-DD.');
  const kind = String(sport || 'Soccer').trim();
  const data = await getJson(`eventsday.php?d=${day}&s=${q(kind)}`);
  const matches = (data?.events || []).map(matchOf).slice(0, 40);
  return {
    text: matches.length
      ? `${kind} on ${day} (${matches.length}${KEY() === '123' ? ', a sample — the free feed does not list every match' : ''}):\n${matches.map((m) => `- ${matchLine(m)}`).join('\n')}`
      : `No ${kind} matches listed for ${day}.`,
    card: { type: 'scores', title: `${kind} · ${day}`, subtitle: '', badge: '', sections: [{ heading: 'day', matches }] },
  };
}

async function playerReport(name) {
  const data = await getJson(`searchplayers.php?p=${q(name)}`);
  const players = (data?.player || []).slice(0, 5);
  if (!players.length) throw new Error(`No player called "${name}" was found.`);
  return {
    text: players
      .map((p) => `${p.strPlayer} — ${p.strPosition || '?'}, ${p.strTeam || 'no team'}${p.strNationality ? `, ${p.strNationality}` : ''}${p.dateBorn ? `, born ${p.dateBorn}` : ''}`)
      .join('\n'),
    card: null,
  };
}

/**
 * @param {{ op?: string, team?: string, league?: string, date?: string, sport?: string, player?: string }} input
 */
export async function sportsTool({ op, team, league, date, sport, player }) {
  const report =
    op === 'team' ? await teamReport(team)
    : op === 'league' ? await leagueReport(league)
    : op === 'day' ? await dayReport(date, sport)
    : op === 'player' ? await playerReport(player)
    : null;
  if (!report) throw new Error('op is team, league, day or player.');
  const content = untrusted('TheSportsDB', `${report.text}\nSource: TheSportsDB (thesportsdb.com).`);
  if (!report.card) return content;
  return {
    content: `${content}\nA scores card is drawn in the conversation; say what matters rather than reading every line back.`,
    widget: { kind: 'card', title: report.card.title, card: report.card },
  };
}

export const __testing = { LEAGUES, leagueId };
