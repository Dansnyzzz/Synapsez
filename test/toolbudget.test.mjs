/**
 * What the tool catalogue costs, measured against the window it has to fit in.
 *
 * The catalogue is re-sent on every step of every turn, so its size is a tax on
 * the whole conversation. The rule used to be an absolute one — trim below a
 * 40k window — which got both ends wrong: a 65k model with a paired computer
 * carried the full 12k catalogue (nearly a fifth of its window) untrimmed, while
 * a 30k model with no computer had its descriptions cut for a catalogue that was
 * only 5k. What matters is the share, not the size, and that is what is pinned
 * here.
 *
 *   node test/toolbudget.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'budget-test-key';
process.env.SESSION_SECRET ||= 'budget-test-secret';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { availableTools, TOOLS, __testing } = await import('../server/tools/definitions.js');
const { estimateTokens } = __testing;

/**
 * The whole catalogue, with nothing held back.
 *
 * `activated` naming every tool is how deferral is switched off for a
 * measurement: what these sections are about is *trimming* — shortening
 * descriptions and dropping optional tools to fit a window — and deferral is a
 * separate mechanism that would otherwise change the numbers underneath them.
 * The section at the bottom tests deferral on its own terms.
 */
const everything = new Set(TOOLS.map((t) => t.name));
const all = (context, workerOnline = true) =>
  availableTools({
    workerOnline,
    desktopOnline: workerOnline,
    policy: 'auto',
    context,
    activated: everything,
  });
const full = (t) => t.description.length;

section('a catalogue that fits comfortably is left alone');
{
  // A big window: the guidance in the long descriptions is what stops a model
  // reaching for the wrong tool, and there is room for it.
  const roomy = all(1_000_000);
  const untrimmed = all(0); // no context stated at all
  check('nothing is trimmed on a large window', roomy.map(full).join() === untrimmed.map(full).join());
  check('and the share is small', estimateTokens(roomy) < 1_000_000 * 0.12, `${estimateTokens(roomy)} tok`);
}

section('a catalogue that would crowd the window is cut down');
{
  const big = estimateTokens(all(1_000_000));
  // A window where the full catalogue is over its share, but the trimmed one is
  // comfortably under — so descriptions are shortened and nothing is dropped.
  const window = big * 5;
  const cut = all(window);
  check('descriptions are shortened', estimateTokens(cut) < big, `${estimateTokens(cut)} < ${big}`);
  check('but every tool is still offered', cut.length === all(1_000_000).length, `${cut.length}`);
  check('and it now fits the allowance', estimateTokens(cut) <= window * 0.2, `${estimateTokens(cut)} of ${window}`);
}

section('a window too small even for that drops the optional tools');
{
  const big = estimateTokens(all(1_000_000));
  const tiny = Math.round(big / 2); // catalogue is twice the window
  const cut = all(tiny);
  const secondary = all(1_000_000).filter((t) => t.secondary).map((t) => t.name);
  check('there are optional tools to drop', secondary.length > 0, secondary.join(','));
  check('and none of them survive', cut.every((t) => !secondary.includes(t.name)), cut.length + ' left');
  check('while the essential ones do', cut.some((t) => t.name === 'web_search'));
}

section('the decision is by share, not by absolute window size');
{
  // The bug this replaces: the same catalogue was trimmed or not depending only
  // on the window, so a small catalogue in a mid-size window was cut for nothing.
  //
  // "Small" is what an ordinary turn is offered: the cloud tools, with the rare
  // ones deferred behind load_tools. Every tool in it must keep its whole
  // description. (Every tool loaded at once is no longer small — the everyday
  // toolbox took it past 12% of 65k — and the next check pins that it is then
  // trimmed, which is the same rule working.)
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  const small = availableTools({ workerOnline: false, desktopOnline: false, policy: 'auto', context: 65_000 });
  check(
    'a small catalogue in a 65k window keeps its guidance',
    small.every((t) => t.name === 'load_tools' || t.description === byName[t.name]?.description),
    `${estimateTokens(small)} tok of 65k`,
  );
  const loadedAll = availableTools({ workerOnline: false, desktopOnline: false, policy: 'auto', context: 65_000, activated: everything });
  const loadedAllUntrimmed = availableTools({ workerOnline: false, desktopOnline: false, policy: 'auto', context: 0, activated: everything });
  check(
    'and past its share — every tool loaded at once — it is trimmed',
    estimateTokens(loadedAllUntrimmed) > 65_000 * 0.12 && estimateTokens(loadedAll) < estimateTokens(loadedAllUntrimmed),
    `${estimateTokens(loadedAll)} < ${estimateTokens(loadedAllUntrimmed)}`,
  );

  // The same window, but with a paired computer the catalogue is far larger —
  // now it does need cutting.
  const large = availableTools({ workerOnline: true, desktopOnline: true, policy: 'auto', context: 65_000, activated: everything });
  const largeUntrimmed = availableTools({ workerOnline: true, desktopOnline: true, policy: 'auto', context: 0 });
  check(
    'the same window with a full catalogue does get cut',
    estimateTokens(large) < estimateTokens(largeUntrimmed),
    `${estimateTokens(large)} < ${estimateTokens(largeUntrimmed)}`,
  );
}

// ── the rarely-used half is described, not sent ─────────────────────
section('tools a turn probably will not use are deferred');
{
  const opts = {
    workerOnline: true,
    desktopOnline: true,
    policy: 'guarded',
    connected: ['slack', 'github', 'notion', 'telegram', 'meta'],
    providers: ['google', 'openai'],
  };
  const loaded = availableTools({ ...opts, context: 200_000, activated: everything });
  const deferred = availableTools({ ...opts, context: 200_000, activated: new Set() });

  const saved = estimateTokens(loaded) - estimateTokens(deferred);
  check(
    'a 200k window sends far fewer tokens of schema',
    saved > 4000,
    `${estimateTokens(loaded)} → ${estimateTokens(deferred)} tok, saved ${saved}`,
  );

  const names = new Set(deferred.map((t) => t.name));
  check('the meta-tool is offered instead', names.has('load_tools'));
  check('  and it names what is missing', /- chart:/.test(deferred.find((t) => t.name === 'load_tools').description));

  /*
   * The line between the two halves is the whole design. A turn that needs to
   * read a file, run a command, drive the browser or search needs it now — an
   * extra round trip to be handed `read_file` would be absurd. Writing a
   * spreadsheet or posting to Slack is a different kind of act.
   */
  for (const core of ['read_file', 'write_file', 'run_command', 'web_search', 'web_fetch', 'browser_look', 'search_docs', 'update_plan']) {
    check(`${core} is never deferred`, names.has(core));
  }
  for (const rare of ['chart', 'create_file', 'slack_post', 'deep_research', 'desktop_click', 'schedule_task']) {
    check(`${rare} waits to be asked for`, !names.has(rare));
  }

  // Asking for one brings it back, and only it.
  const after = availableTools({ ...opts, context: 200_000, activated: new Set(['chart']) });
  const afterNames = new Set(after.map((t) => t.name));
  check('activating a tool loads it', afterNames.has('chart'));
  check('  without loading its neighbours', !afterNames.has('create_file'));

  /*
   * Above a certain window the catalogue is genuinely noise and the extra round
   * trip would cost more than the schemas do. The threshold is a share for that
   * reason, not an absolute.
   */
  const roomy = availableTools({ ...opts, context: 1_000_000, activated: new Set() });
  check(
    'a very large window keeps everything to hand',
    !roomy.some((t) => t.name === 'load_tools') && roomy.some((t) => t.name === 'chart'),
    `${estimateTokens(roomy)} tok of 1M`,
  );

  // A sub-agent gets one short read-only job; a round trip to load a tool would
  // be a large fraction of its entire life.
  const sub = availableTools({ ...opts, context: 200_000, activated: new Set(), subagent: true, policy: 'readonly' });
  check('a sub-agent is exempt', !sub.some((t) => t.name === 'load_tools'));
}

section('The load_tools index');
{
  const { firstSentence } = __testing;
  check('a first sentence runs past "e.g."', firstSentence('Press a key, e.g. ctrl+s. More.') === 'Press a key, e.g. ctrl+s.');
  check('  and still stops at a real full stop', firstSentence('One. Two.') === 'One.');

  const opts = { workerOnline: true, desktopOnline: true, policy: 'guarded', connected: [], providers: [], context: 200_000 };
  const index = availableTools({ ...opts, activated: new Set() }).find((t) => t.name === 'load_tools').description;
  const desktop = TOOLS.filter((t) => t.scope === 'desktop').map((t) => t.name);
  check('a family is one line', index.split('\n').filter((l) => l.includes('desktop_')).length === 1);
  check('  that still names every member exactly', desktop.every((n) => index.includes(n)), desktop.join(','));
  // One member activated leaves the rest listed, not the family's summary of a set it no longer is.
  const partial = availableTools({ ...opts, activated: new Set(['desktop_click']) }).find((t) => t.name === 'load_tools').description;
  check('an activated member drops out of its family line', !partial.includes('desktop_click') && partial.includes('desktop_key'));
  // Every deferred tool must be loadable by a name the index shows.
  const loaded = new Set(availableTools({ ...opts, activated: new Set() }).map((t) => t.name));
  const all = availableTools({ ...opts, activated: new Set(TOOLS.map((t) => t.name)) }).map((t) => t.name);
  const missing = all.filter((n) => !loaded.has(n) && !index.includes(n));
  check('nothing held back is missing from the index', missing.length === 0, missing.join(','));
}

section('Prompt caching through OpenRouter');
{
  const { markPromptCache } = await import('../server/providers/openaiCompatible.js');
  const base = () => ({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }] });
  const claude = markPromptCache(base(), 'anthropic/claude-sonnet-5');
  check('Claude gets automatic caching at the root', claude.cache_control?.type === 'ephemeral');
  const gemini = markPromptCache(base(), 'google/gemini-3-pro');
  check('Gemini gets a breakpoint on the system block', gemini.messages[0].content[0].cache_control?.type === 'ephemeral' && gemini.messages[0].content[0].text === 'S');
  const other = markPromptCache(base(), 'deepseek/deepseek-chat');
  check('a model that caches on its own is left alone', !other.cache_control && other.messages[0].content === 'S');
}

console.log(
  failures === 0 ? '\n\x1b[32mAll tool-budget checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
