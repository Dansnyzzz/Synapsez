---
description: Audit what this app spends of the user's token budget, and cut waste.
allowed-tools: Read, Grep, Glob, Bash, PowerShell
---

Audit token spend. The user pays for every token, so waste here is not an
abstraction — it is somebody's credit disappearing into text no one reads.

The rule that makes this worth auditing at all: **the entire prompt is re-sent on
every single turn.** Anything constant is not paid for once, it is paid for on
every request for the rest of the conversation.

## 1. The tool catalogue — the biggest constant

`server/tools/definitions.js` holds 93 tools — about **13,300 tokens** of JSON
schema if you send all of it. What a turn actually sends is **48 tools, ~6,900
tokens** on a 128k window, because deferral drops the rest until they are asked
for. Those are two different numbers and they get conflated constantly; measure
`availableTools({ context })`, not `TOOLS`.

Existing defences — confirm they still hold, and that new tools respect them:

- `TRIM_DESCRIPTIONS_BELOW` (40k): descriptions cut to `firstSentence`. So the
  **first sentence of every description must stand alone.** Check new tools.
- `DROP_SECONDARY_BELOW` (16k): `secondary: true` tools dropped entirely. Check
  that non-core tools are actually marked.
- `needs` / `needsProvider`: a tool whose connector or key is absent is withheld.
  This is pure savings for every account that has not linked that service — an
  unmarked connector tool bills every user for a schema they can never use.
- `workerOnline` / `desktopOnline`: local tools are not advertised when nothing
  can run them.

Measure rather than assume:

```
node --input-type=module -e "import('./server/tools/definitions.js').then(m=>{const j=x=>JSON.stringify(x).length;for(const c of [200000,40000,16000,8000]){const t=m.availableTools({workerOnline:true,desktopOnline:true,context:c});console.log(c, t.length+' tools', Math.round(j(t)/4)+' est tokens')}})"
```

Report the numbers. A small-window model should be visibly cheaper.

## 2. Conversation growth

`server/compact.js` folds old turns into a summary at `COMPACT_AT` (0.82 of the
window), keeping the newest whole turns verbatim up to `KEEP_SHARE` (10% of the model's window, at least `KEEP_FLOOR` 4,000 tokens; the newest question and what follows it always stay), folding inside a long turn when that leaves nothing older (the question is kept by a `question` pointer and put back whole by `activeTranscript`, never summarised), and it chains so cost stays
flat however long the conversation runs. Verify:

- compaction triggers before the window is full — the compaction call itself must
  fit, or the request that fails is the one meant to fix the problem;
- the summary is reused, not recomputed from the whole history each time;
- `estimateTokens` is only applied to the untallied tail, never the whole
  transcript. Its 4-chars-per-token assumption is wrong for code and wrong for
  Vietnamese, and the design already accounts for that by keeping its blast
  radius to a few messages. Do not widen it.

## 3. Output budget

`outputBudget(entry)` derives `max_tokens` from the model's own cap, clamped
inside its context window. Confirm no adapter reintroduces a flat `32000` — 45
catalogue models cap below it, and `openai/gpt-4`'s entire window is 8191.

## 4. Things that quietly cost a fortune

- **Images**: ~1200 tokens each, and they persist in the transcript for every
  later turn. Check they are resized before sending and dropped when compacted.
- **Tool results**: a `read_file` or `grep` returning a whole file is often the
  largest thing in the window. Confirm results are truncated with a stated limit.
- **The system prompt**: constant, and paid every turn. Audit it for length.
- **RAG chunks** (`server/rag.js`): confirm top-k is bounded and chunks are
  deduplicated.
- **Retries**: `streamCompletion` must not re-send a whole prompt to a second key
  for an error that will fail identically on every key. `keyExhausted` is what
  decides this — a wrong `true` there multiplies the cost of one bad request by
  the number of keys.

## 5. Report

Give measured numbers, ranked by tokens saved per turn. Distinguish "constant,
every request" from "once per conversation" — they are not the same money.
