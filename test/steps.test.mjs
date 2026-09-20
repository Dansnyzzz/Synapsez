/**
 * No answer is hidden inside "Reasoning".
 *
 * A model that puts its whole reply on the reasoning channel and leaves
 * `content` empty ended the turn with a correct answer folded into a collapsed
 * block and an empty bubble beside it — which reads as the assistant having
 * said nothing at all.
 *
 * The other half of this — that every step says what it did in words rather
 * than printing its own function name — needs a DOM, so it lives in
 * `test/ui.test.mjs` where there is a real browser, with the catalogue-wide
 * sweep in `test/i18n.test.mjs`.
 *
 *   node test/steps.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'steps-test-key';
process.env.SESSION_SECRET ||= 'steps-test-secret';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { promoteReasoning } = await import('../server/agent.js');

section('a reply that arrived as reasoning is shown as the reply');
{
  const turn = { text: '', thinking: 'Không, tôi không thể tạo 100 câu.', toolCalls: [] };
  const moved = promoteReasoning(turn);
  check('it is promoted', moved && turn.text === 'Không, tôi không thể tạo 100 câu.');
  check('and is not left in the reasoning block as well', turn.thinking === '');
  check('the turn records that this happened', turn.reasonedAloud === true);
}

section('and a turn that said something is left alone');
{
  const spoke = { text: 'Here it is.', thinking: 'I should check the file first.', toolCalls: [] };
  check('prose wins over reasoning', !promoteReasoning(spoke) && spoke.thinking !== '');

  /**
   * The case that would be a privacy failure rather than a display one.
   *
   * A turn whose point was a tool call is *supposed* to look like thinking
   * followed by an action. Promoting that would paste a private deliberation
   * into the conversation as though it had been addressed to the user.
   */
  const acting = { text: '', thinking: 'The user is probably wrong about this.', toolCalls: [{ name: 'web_fetch' }] };
  check('a turn that called a tool keeps its reasoning private', !promoteReasoning(acting) && acting.text === '');

  const silent = { text: '', thinking: '   ', toolCalls: [] };
  check('and an empty turn invents nothing', !promoteReasoning(silent) && silent.text === '');
}

console.log(
  failures === 0 ? '\n\x1b[32mNo answer is hidden inside the reasoning block.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
