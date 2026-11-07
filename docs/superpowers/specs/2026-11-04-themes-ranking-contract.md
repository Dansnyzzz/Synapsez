# Themes, ranking, titles, mascot: the contract (2026-11-04, revised 2026-11-07)

From the owner's round of 2026-11-04 (their sketches 3, 4, 5; account menu 6; whale sheet 7 and placement 8;
three reference videos of animated wallpapers). The server and the browser are built side by side against this file.

## Words

- **Theme**: a look for the whole app. `default` is the app as it is now and everyone holds it. Every other theme is an
  animated scene drawn on a canvas behind the app.
- **Badge**: what a theme is called in the right-hand panel. One per theme, chosen by an administrator.
- **Title**: a short honour a person earns and may equip. It shows beside their name on the leaderboard.
- **Period**: a UTC calendar quarter (`2026-Q4`) or year (`2026`). Usage counts from 2026-11-01.

## Catalogue (same ids on both sides; a test pins that they agree)

`server/themes.js` holds the rules, `public/js/scenes/` the drawings and `public/js/scenes/catalog.js` what the page may know of them.
A theme's "ui mode" below is what it was painted for: the interface's light or dark is always the person's own setting.

| id | scene | ui mode | default badge | how it is earned by default |
|---|---|---|---|---|
| `default` | none | follows the light/dark setting | `none` | everyone |
| `cloud-drift` | pale sky, drifting clouds | light | `achievement` | 100,000 lifetime tokens |
| `moon-night` | indigo night, crescent, stars | dark | `achievement` | 1,000,000 lifetime tokens |
| `lagoon` | turquoise lagoon, turtle, fish | light | `achievement` | 10,000,000 lifetime tokens |
| `firefly-grove` | dark forest, fireflies | dark | `achievement` | 50,000,000 lifetime tokens |
| `deep-sea` | abyss, jellyfish | dark | `achievement` | 100,000,000 lifetime tokens |
| `nebula-voyage` | a boat on a sea of stars | dark | `achievement` | 1,000,000,000 lifetime tokens |
| `rainy-cafe` | a café in the rain | dark | `achievement` | $10 spent |
| `golden-harbor` | a harbour at sunset | light | `achievement` | $100 spent |
| `crystal-palace` | a cavern of crystal | dark | `achievement` | $1,000 spent |
| `new-year-fireworks` | fireworks over a river | dark | `exclusive_event` | 500,000 tokens from 1 to 7 January 2027, first 100 people |
| `aurora-peak` | aurora over snowy peaks | dark | `exclusive_event` | given by an administrator |
| `snow-village` | Christmas snow village | dark | `top_quarter` Q4/2026 | top 3 of that quarter, either board |
| `tet-spring` | Lunar New Year of the Goat | light | `top_quarter` Q1/2027 | top 3 of that quarter, either board |
| `phoenix-summer` | flame trees over a schoolyard | light | `top_quarter` Q2/2027 | top 3 of that quarter, either board |
| `mid-autumn` | Mid-Autumn lantern parade | dark | `top_quarter` Q3/2027 | top 3 of that quarter, either board |
| `maple-river` | an autumn river | light | `top_quarter` Q4/2027 | top 3 of that quarter, either board |
| `golden-horse` | horses at dawn | light | `top_year` 2026 | top 3 of that year, either board |
| `goat-terrace` | rice terraces and goats | light | `top_year` 2027 | top 3 of that year, either board |
| `sakura-crossing` | blossom, level crossing at sunset | light | `top_quarter` (any quarter) | top 3 of a quarter with no theme of its own |
| `rose-street` | pink dusk, city corner | dark | `top_year` (any year) | top 3 of a year with no theme of its own |

Art is original, drawn by code. The reference videos belong to their makers and nothing in them is traced or copied: no
signage text, no characters, no logos.

## Badge

`{ kind, quarter, year }`, where `kind` is one of `none`, `exclusive_event`, `achievement`, `top_quarter`, `top_year`.

- `top_quarter`: `year` and `quarter` name one quarter ("Top Q1/2027"); both null means every quarter ("Top quý").
- `top_year`: `year` names one year ("Top Year 2026"); null means every year.
- An administrator's choice wins over the default. A period's closing gives the theme(s) carrying that period, or else the
  "any" one(s).
- The text is the browser's, from the locale files. The server sends only this object.

## HTTP (all JSON, all behind sign-in, the app's usual `{ error }` on failure)

### `GET /api/themes`

```json
{ "selected": "default", "isAdmin": false,
  "progress": { "tokens": 150000, "spend": 0.4 },
  "themes": [ { "id": "lagoon", "badge": { "kind": "achievement", "quarter": null, "year": null },
                "owned": true, "grantedAt": "2026-11-04T00:00:00.000Z",
                "grant": { "kind": "top_quarter", "quarter": 4, "year": 2026 },
                "needs": null } ] }
```

The order is the display order: held themes first, newest grant first; then locked ones in catalogue order. `grant` is why
this person holds it (null for `default` and for an administrator's blanket access). `needs` on a locked achievement theme
is `{ "tokens": 1000000 }` or `{ "spend": 10 }`, on a locked event `{ "event": { "from", "to", "tokens", "places", "left", "used", "state" } }`,
otherwise null. An administrator holds everything, and takes no event's place.

### `PUT /api/themes/selected` `{ "id": "lagoon" }`

Returns `{ "selected": "lagoon" }`. A theme this person does not hold is `403`, an unknown id `400`.

### `GET /api/ranking?scope=quarter|year&key=2026-Q4`

Both query parameters are optional: the current period by default. `key` must be a period that exists.

```json
{ "scope": "quarter", "key": "2027-Q1", "keys": ["2027-Q1", "2026-Q4"], "closes": "2027-04-01T00:00:00.000Z", "settled": false,
  "tokens": [ { "rank": 1, "name": "alice", "title": { }, "value": 12345, "isMe": false } ],
  "spend":  [ { "rank": 1, "name": "bob", "title": null, "value": 12.34, "isMe": true } ],
  "me": { "excluded": false, "anonymous": false,
          "tokens": { "rank": 5, "value": 100 }, "spend": { "rank": null, "value": 0 } } }
```

Ten rows at most per board, of which the first three win. Spend is in US dollars as the app recorded it. Only an account name is ever shown, never an
email. Someone who chose to stay anonymous has `name: null` (the browser says "A member"). Administrators are not on the
boards; `me.excluded` is true for them. A board with nobody on it is an empty list.

### Titles

`GET /api/titles` returns `{ "equipped": "<id>|null", "progress": { "tokens", "spend" }, "titles": [ <title>, … ] }`, held ones first, newest first.

`PUT /api/titles/equipped` `{ "id": "<id>"|null }` returns `{ "equipped": … }`; `403` for one this person does not hold.

A title is one of:

```json
{ "id": "tokens-1m", "kind": "catalog", "owned": true, "earnedAt": "…", "needs": null }
{ "id": "top:tokens:quarter:2026-Q4:1", "kind": "award", "board": "tokens", "scope": "quarter", "key": "2026-Q4", "rank": 1,
  "owned": true, "earnedAt": "…" }
{ "id": "rank-1", "kind": "rank", "rank": 1, "owned": false, "earnedAt": null, "needs": { "rank": 1 } }
```

Catalog titles and what earns them (lifetime, from recorded usage):

| id | earned by |
|---|---|
| `newcomer` | any account |
| `tokens-1m` | 1,000,000 tokens |
| `tokens-10m` | 10,000,000 tokens |
| `tokens-100m` | 100,000,000 tokens |
| `tokens-1b` | 1,000,000,000 tokens |
| `spend-10` | $10 spent |
| `spend-100` | $100 spent |
| `spend-1000` | $1,000 spent |

A locked catalog title has `needs: { "tokens": n }` or `{ "spend": n }`. Award titles exist only for those who hold them; `rank-N` stands for
each place until it is won, to be looked at, and can never be worn.
An administrator may equip any catalog title.

### Preferences (the existing `/api/prefs`)

- `mascot`: `auto` (default), `off`, or one of `idle thinking typing conducting notification error happy sleeping`.
- `rankAnonymous`: boolean, default false.

### Administration (permission `themes`, owner and blanket administrators have it)

- `GET /api/admin/themes` returns `{ "themes": [ { "id", "badge", "holders": 3 } ] }`.
- `GET /api/admin/themes/people` returns `{ "people": [ { "id", "name" } ] }`: everyone a theme can be given to, names only. Use this for the search box, not `/api/admin/users`, which this permission does not reach.
- `GET /api/admin/themes/:id/holders` returns `{ "holders": [ { "id", "name", "grantedAt" } ] }`.
- `PUT /api/admin/themes/:id` `{ "kind", "quarter", "year" }` returns `{ "badge": … }`. `default` stays `none`.
- `POST /api/admin/themes/:id/holders` `{ "userId" }` gives it. `DELETE /api/admin/themes/:id/holders/:userId` takes it back.

## Theme page (Settings)

Three panels as in the sketches: the Settings sidebar, a grid of theme tiles, and the preview panel.

- Each tile shows a still frame with the theme's name under it. Hovering or focusing another theme's tile plays it. The
  theme in use never moves on its tile, hovered or not.
- Pressing a tile opens it in the right panel. If it is held it also applies at once, and it is saved at once (no Save button).
- The right panel plays the theme large, always, with its name, what it means, and its badge. The `none` badge is drawn as
  a quiet chip.
- A locked tile is dimmed and carries a padlock, and pressing it shows it in the right panel, dimmed, padlocked and still
  moving, with what earns it. It never applies.
- Reduced motion: every scene is a still frame, and nothing plays on hover.

The account menu gains a Theme row that opens this page.

## Ranking page (Settings)

Quarter or year; a period picker; two boards (tokens, spend), each its top 10 with name and equipped title, the first three in
gold, silver and bronze; your own place; when the period closes. A switch to show "A member" instead of your name. Then titles,
as chips with a panel beside them: a press shows the title's creature, what it is and what earns it, and wears it if it is held.
One not held is dimmed, and can be pressed to look.

## Mascot

`public/assets/mascot/<state>.gif`, MIT from `Nwflower/dsh-claude-style`, art credited to calmly-eating-bugs
(`public/assets/mascot/NOTICE.txt` carries both). Standing on the composer's top edge at its right, in both composers, never
catching a press, never covering text. `auto` follows the run: idle, thinking, typing (reply or tool), conducting
(sub-agents), notification (waiting on the person), error, happy (just finished, a few seconds), sleeping (idle two minutes).
Any other value stays that one. `off` draws nothing. Reduced motion: a still frame.
