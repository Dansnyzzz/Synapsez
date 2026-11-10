/**
 * Which steps the Progress list shows (owner, 2026-11-09, screenshots 2 to 7): the step
 * the run is on, at most the two before it and what is still to come; the rest behind
 * "N earlier steps"; once every step is done, the last two.
 *
 *   node test/plan-window.test.mjs
 */
import { planWindow, samePlan, RECENT_DONE } from '../public/js/plan-window.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** A plan from a string of states: d done, r running, p pending. */
const plan = (states) =>
  [...states].map((c, i) => ({ title: `Step ${i + 1}`, status: c === 'd' ? 'done' : c === 'r' ? 'in_progress' : 'pending' }));
const shown = (states, expanded = false) => {
  const steps = plan(states);
  const view = planWindow(steps, expanded);
  return steps.slice(view.start).map((s) => s.title.replace('Step ', '')).join('');
};

section('nothing to show');
{
  const view = planWindow([]);
  check('no steps, no window', view.current === -1 && view.earlier === 0 && view.start === 0 && view.total === 0, JSON.stringify(view));
  check('not a list is no steps', planWindow(/** @type {any} */ (null)).total === 0);
}

section('running: the step, at most two before it, and everything after (screenshot 4)');
{
  check('two finished keep the button away', planWindow(plan('ddrp')).earlier === 0 && shown('ddrp') === '1234');
  check('one finished, the current, two to come', shown('drpp') === '1234' && planWindow(plan('drpp')).current === 1);
  check('nothing started: the first step is where it is', planWindow(plan('pppp')).current === 0 && shown('pppp') === '1234');
  check('the first step running', planWindow(plan('rppp')).current === 0 && planWindow(plan('rppp')).earlier === 0);
  const seventh = planWindow(plan('ddddrpp'));
  check('step five of seven: two folded', seventh.earlier === 2 && seventh.start === 2 && shown('ddddrpp') === '34567', JSON.stringify(seventh));
  check('the window keeps exactly the recent ones', RECENT_DONE === 2);
}

section('the last step running is the same: the recent three (screenshot 2)');
{
  const last = planWindow(plan('dddr'));
  check('"1 earlier step"', last.earlier === 1 && shown('dddr') === '234', JSON.stringify(last));
  check('not finished while the last step runs', last.finished === false && last.current === 3);
  check('all of them once pressed (screenshot 5)', shown('dddr', true) === '1234' && planWindow(plan('dddr'), true).earlier === 1);
}

section('finished: the last two, the tick on the last (screenshot 6)');
{
  const done = planWindow(plan('dddd'));
  check('"2 earlier steps" over the last two', done.finished && done.earlier === 2 && shown('dddd') === '34', JSON.stringify(done));
  check('the step it is on is the last', done.current === 3);
  check('every step once pressed (screenshot 7)', shown('dddd', true) === '1234');
  check('a two-step plan has nothing to fold', planWindow(plan('dd')).earlier === 0 && shown('dd') === '12');
  check('a long one folds all but two', planWindow(plan('ddddddd')).earlier === 5 && shown('ddddddd') === '67');
}

section('between two updates, and plans out of order');
{
  check('nothing in progress: the next step to do is the current', planWindow(plan('dddpp')).current === 3 && shown('dddpp') === '2345');
  check('a step skipped stays counted where it is', planWindow(plan('pdddr')).earlier === 2 && shown('pdddr') === '345');
  const first = planWindow(plan('pddd'));
  check('a step left undone is not "finished"', first.finished === false && first.current === 0 && first.earlier === 0, JSON.stringify(first));
}

section('the same plan carried on, or a new one');
{
  const a = [{ title: 'Read the file' }, { title: 'Write  the answer' }];
  check('the same titles, carried on', samePlan(a, [{ title: 'read the file' }, { title: 'Write the answer' }, { title: 'Check it' }]));
  check('one step kept is still the same plan', samePlan(a, [{ title: 'Write the answer' }, { title: 'Something new' }]));
  check('nothing in common is a new plan', !samePlan(a, [{ title: 'Plan a trip' }, { title: 'Book it' }]));
  check('the first plan is new', !samePlan([], a));
  check('empty titles do not make two plans one', !samePlan([{ title: '' }], [{ title: '  ' }]));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
