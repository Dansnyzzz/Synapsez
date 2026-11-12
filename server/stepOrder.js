import { TOOLS_BY_NAME } from './tools/definitions.js';

/**
 * One step finished before the next begins (owner, 2026-11-04).
 *
 * A model asked for `update_file` and `read_generated_file` in one breath. Both
 * ran at the same moment, 453 ms each: the write failed, the read handed back the
 * unchanged file, and the same pair came round again. The rules here are what the
 * owner asked for: a step that changes something runs alone and in order, a later
 * step waits for it, a failed one is put right before anything after it runs, and
 * nothing is called twice when calling it again cannot help.
 *
 * Pure apart from the catalogue, so the decisions can be tested without a model.
 */

/** The formats a model can be shown as pictures; see server/fileLook.js. */
export const LOOKS = new Set(['docx', 'xlsx', 'pptx']);

/**
 * Calls that change something but touch nothing another call depends on. Four
 * pictures take a minute side by side and four minutes in a queue.
 */
const INDEPENDENT = new Set(['generate_image', 'make_qr']);

/**
 * Whether this call must run on its own. A tool outside the catalogue (MCP) counts
 * as able to change something, the same default `resumableCalls` uses.
 *
 * @param {{ name: string }} call
 */
const runsAlone = (call) => TOOLS_BY_NAME[call.name]?.readOnly !== true && !INDEPENDENT.has(call.name);

/**
 * A batch of calls as the order they run in: reads side by side, each change alone.
 *
 * @template {{ name: string }} T
 * @param {T[]} calls
 * @returns {{ alone: boolean, calls: T[] }[]}
 */
export function batchSegments(calls) {
  /** @type {{ alone: boolean, calls: T[] }[]} */
  const segments = [];
  for (const call of calls || []) {
    const alone = runsAlone(call);
    const last = segments[segments.length - 1];
    if (!alone && last && !last.alone) last.calls.push(call);
    else segments.push({ alone, calls: [call] });
  }
  return segments;
}

/**
 * The answer to a call left unrun because the step before it failed. The screen
 * draws no row for it (`skipped`): nothing happened, and the model is the one who
 * needs to know.
 *
 * @param {{ id?: string, name: string }} call
 * @param {string} failedName
 */
export const skippedAfterFailure = (call, failedName) => ({
  toolCallId: call.id,
  name: call.name,
  content:
    `Not run: ${failedName}, the step before this one, failed, so nothing after it was started. ` +
    'Put that step right first and call it again; call this only once that has worked.',
  isError: true,
  skipped: true,
  ms: 0,
});

/** Files the assistant writes in this app, whose id is on the result. */
const WRITES_A_FILE = new Set(['create_file', 'update_file']);

/** Asked of a file the app holds; the answer changes only when the file does. */
const READS_A_KEPT_FILE = new Set(['read_generated_file', 'look_at']);

/** Asked of the world; the answer holds until something this turn changes something. */
const SETTLED_READS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'look_at', 'calculate', 'convert_units', 'date_calc']);

/**
 * Asking again can honestly give another answer: a screen, a running process, a
 * command that is being waited on. Only failing the same way over and over stops
 * these.
 */
const LIVE = /^(browser_|desktop_)|^(cloud_browser|run_command|run_background|run_background_logs|run_background_stop|sandbox_run|process_list|system_stats|clipboard_read|market_data|world_facts|sports|update_plan|ask_options|notify)$/;

/**
 * A message or post that lands on somebody else (harness audit, 2026-11-12): the identical one
 * that went out earlier in the turn is not sent again. Only file writes and settled reads were
 * checked, so a model that lost track sent the same Slack post, Gmail, Telegram message or
 * POST once a step — up to five times under `auto`. A Gmail draft, a GET, are not sends.
 *
 * @param {{ name: string, input?: any }} call
 */
const sendsSomething = (call) =>
  /^(send_email|slack_post|telegram_send|meta_page_post|github_write)$/.test(call.name) ||
  (call.name === 'gmail' && /^(send|reply|forward)$/i.test(String(call.input?.action || ''))) ||
  (call.name === 'http_request' && !/^(GET|HEAD|OPTIONS)$/i.test(String(call.input?.method || 'GET')));

/** A failure that the same call can only repeat: the file is what the edit does not match. */
const CERTAIN_FAILURE = /did not match|matches more than once|has nothing to find|There is no file|was uploaded|has no stored source|Pass content/;

/** How many times one exact failing call may run. */
const MAX_SAME_FAILURES = 2;

const stringify = (value) => {
  /** Keys sorted at every depth, so `{a, b}` and `{b, a}` are one call. */
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
        : v;
  try {
    return JSON.stringify(canonical(value ?? {}));
  } catch {
    return null;
  }
};

/**
 * What this turn has done so far, enough to say "that would change nothing".
 *
 * Built from the transcript as well as added to while running, because a turn can
 * span several function invocations: an approval, a cut-off, a reconnect.
 *
 * @param {any[]} [messages]  the conversation; only what follows the last thing the person wrote is read
 */
export function createStepGuard(messages = []) {
  /** Bumped by anything that may have changed something; settled reads compare against it. */
  let world = 0;
  /** @type {Map<string, { world: number, version: number, fileId: string }>} */
  const succeeded = new Map();
  /** @type {Map<string, { count: number, content: string, world: number, version: number }>} */
  const failed = new Map();
  /** @type {Map<string, { name: string, version: number, lookedAt: number, format: string }>} */
  const files = new Map();
  let looks = 0;
  /** A background process started in this turn and not stopped. */
  let background = false;

  /** A person's file by the id of the copy its changes are on: the first change to it makes one. */
  const copies = new Map();
  const fileIdOf = (call) => {
    const asked = call.name === 'update_file' || READS_A_KEPT_FILE.has(call.name) ? String(call.input?.file_id || '') : '';
    return copies.get(asked) || asked;
  };
  const versionOf = (id) => (id ? files.get(id)?.version ?? 0 : 0);
  const keyOf = (call) => {
    const args = stringify(call.input);
    return args === null ? null : `${call.name}:${args}`;
  };

  /**
   * Whether a call should not run, and what to tell the model instead.
   *
   * @param {{ name: string, input?: any }} call
   * @returns {{ content: string, isError: boolean } | null}
   */
  function check(call) {
    const key = keyOf(call);
    if (!key) return null;
    const id = fileIdOf(call);
    const version = versionOf(id);
    const before = failed.get(key);
    const failedAgain = before && before.world === world && before.version === version;
    if (failedAgain) {
      const certain = !LIVE.test(call.name) && CERTAIN_FAILURE.test(before.content);
      if (certain || before.count >= MAX_SAME_FAILURES) {
        return {
          isError: true,
          content:
            `Not run: this exact call already failed${before.count > 1 ? ` ${before.count} times` : ''} and nothing has changed since, so it would fail the same way. ` +
            `It said: ${before.content.slice(0, 400)}\nChange what you send, or tell the person what is stopping you.`,
        };
      }
    }
    if (sendsSomething(call) && succeeded.has(key)) {
      return {
        isError: false,
        content: 'Not sent again: this exact message already went out earlier in this turn. Treat it as sent and carry on — a second copy only if the person asks for one in their next message.',
      };
    }
    if (LIVE.test(call.name)) return null;
    const done = succeeded.get(key);
    if (!done) return null;
    if (WRITES_A_FILE.has(call.name)) {
      if (call.name === 'update_file' && done.version !== version) return null;
      const which = done.fileId ? ` Its id is ${done.fileId}.` : '';
      return { isError: false, content: `Not run: this exact change has already been made, so the file is as you asked.${which} Carry on from there.` };
    }
    if (READS_A_KEPT_FILE.has(call.name) && id) {
      if (done.version !== version) return null;
      return { isError: false, content: `Not read again: ${files.get(id)?.name || 'that file'} has not changed since you read it in this turn. Use what you already have.` };
    }
    // A process left running can change anything at any moment, so nothing is settled while one may be.
    if (SETTLED_READS.has(call.name) && done.world === world && !background) {
      return { isError: false, content: 'Not run again: this exact call already ran in this turn and nothing has changed since. Use its result, above.' };
    }
    return null;
  }

  /**
   * Record how a call went.
   *
   * @param {{ name: string, input?: any }} call
   * @param {{ isError?: boolean, content?: string, skipped?: boolean, file?: any, looked?: boolean, pictures?: any[] }} result
   */
  function note(call, result) {
    if (result?.skipped) return;
    const key = keyOf(call);
    const id = String(result?.file?.id || fileIdOf(call) || '');
    const changes = TOOLS_BY_NAME[call.name]?.readOnly !== true;
    if (call.name === 'run_background') background = true;
    if (call.name === 'run_background_stop' && !result?.isError) background = false;
    if (result?.isError) {
      const before = key ? failed.get(key) : null;
      const version = versionOf(fileIdOf(call));
      const same = before && before.world === world && before.version === version;
      // A command that failed half way may still have changed things. What it tried
      // itself is measured from there, so failing the same way still counts as the same.
      if (changes && !WRITES_A_FILE.has(call.name)) world += 1;
      if (key) failed.set(key, { count: same ? before.count + 1 : 1, content: String(result.content || ''), world, version });
      return;
    }
    if (WRITES_A_FILE.has(call.name) && id) {
      const asked = String(call.input?.file_id || '');
      if (asked && asked !== id) copies.set(asked, id);
      const known = files.get(id);
      const version = (known?.version || 0) + 1;
      files.set(id, {
        name: String(result?.file?.name || known?.name || ''),
        format: String(result?.file?.format || known?.format || ''),
        version,
        lookedAt: result?.looked ? version : known?.lookedAt || 0,
      });
    } else if (READS_A_KEPT_FILE.has(call.name) && id && files.has(id)) {
      // A picture of it, or its text when it has no look: either is having read it.
      const file = files.get(id);
      if (call.name === 'look_at' || !LOOKS.has(file.format)) file.lookedAt = file.version;
    }
    if (result?.pictures?.length) looks += 1;
    // Anything that can change something makes every settled read stale.
    if (changes) world += 1;
    if (key) {
      failed.delete(key);
      succeeded.set(key, { world, version: versionOf(id), fileId: id });
    }
  }

  // This turn so far: what follows the last thing the person wrote.
  const from = messages.findLastIndex((m) => m.role === 'user') + 1;
  const callsById = new Map();
  for (const m of messages.slice(from)) {
    if (m.role === 'assistant') for (const c of m.toolCalls || []) callsById.set(c.id, c);
    else if (m.role === 'tool') {
      for (const r of m.results || []) {
        const call = callsById.get(r.toolCallId);
        if (call) note(call, r);
      }
    }
  }

  return {
    check,
    note,
    /** How many looks this turn has already paid for. */
    get looks() {
      return looks;
    },
    /** Mark a file as seen as it stands. */
    markLooked(id) {
      const file = files.get(String(id));
      if (file) file.lookedAt = file.version;
    },
    /**
     * The files written this turn that have not been checked since they last changed.
     *
     * @returns {{ id: string, name: string, format: string }[]}
     */
    owed() {
      return [...files].filter(([, f]) => f.lookedAt !== f.version).map(([id, f]) => ({ id, name: f.name, format: f.format }));
    },
  };
}

