import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { usesInProcessTools, inProcessImplementations, workerStatus } from '../localTools.js';
import { getPrefs } from '../settings.js';
import { TOOLS_BY_NAME, returnsExternalContent, externalSource } from './definitions.js';
import { CLOUD_IMPLEMENTATIONS } from './cloud.js';
import { isMcpTool, callMcpTool, splitMcpName } from '../mcp/registry.js';
import { keepStepShot } from '../attachments.js';
import { redactSecrets } from '../redact.js';
import { untrusted } from './untrusted.js';
import { validateArguments } from './validate.js';

const POLL_MS = 400;
const DEFAULT_LOCAL_TIMEOUT_MS = 180_000;

/**
 * A tool's failure, with any credential taken out of it.
 *
 * `readableFailure` already does this for a provider error that ends a turn,
 * and the unattended runners do it for a step's stored error. This is the third
 * channel and it was the one still open, because it does not look like a place
 * a provider key could appear.
 *
 * It is. `web_extract` and `deep_research` call a model *inside* a tool, so a
 * client handed a malformed key reports it by quoting the value back — and that
 * sentence becomes this tool's result, which is worse than the other two
 * channels rather than better. A turn's error is shown once; a tool result is
 * streamed to the browser, written into `messages`, and then re-sent to the
 * model on every remaining step of the turn.
 *
 * The same treatment covers an MCP server that echoes its own bearer token, and
 * a worker whose shell printed an environment variable.
 */
const safeError = (error) => redactSecrets(String(error?.message ?? error ?? '')).text;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hand a local tool call to the worker on this user's machine and wait.
 *
 * The worker cannot be dialled into from the internet, so a queue row is the
 * rendezvous point. Both the enqueue and the claim are scoped by `userId`,
 * which is what guarantees a job can only ever run on its own owner's computer.
 */
async function runViaWorker({ user, userId, name, input, chatId, timeoutMs, signal, deviceHint }) {
  const store = getStore();

  // Addressed to one machine rather than left for whoever polls first. With two
  // computers paired, an unaddressed job is a coin toss — and "read that file"
  // landing on the wrong laptop is a confusing failure at best and the wrong
  // file at worst.
  const prefs = await getPrefs(userId);
  const status = await workerStatus(user || { id: userId }, prefs, deviceHint);
  if (!status.online) {
    return {
      isError: true,
      content:
        'No computer is connected to this account, so this tool cannot run. Tell the user to start the Synapse worker on their machine — Settings → Computers has a pairing code — or solve the task with the web tools instead.',
    };
  }

  const id = crypto.randomUUID();
  await store.enqueueJob(userId, { id, chatId, tool: name, input, deviceId: status.activeId });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      /**
       * Says what actually happened, which is less than it used to claim.
       *
       * This marks the job finished on the server and stops waiting. It does
       * **not** reach the worker: there is no cancellation channel — the worker
       * claims a job and runs it to completion, and nothing it polls carries a
       * stop. So a `delete_file` already executing is not called back. The model
       * was told "Cancelled by the user", concluded the file was still there,
       * and said so.
       *
       * Telling the truth is the part that is cheap. Actually propagating the
       * cancellation means a flag the worker checks mid-execution, which is a
       * change across the store, the job protocol and the worker loop — raised
       * as `AUTO-009` rather than half-done here behind an accurate sentence.
       */
      // `cancelled`, and only if the job is still open: the worker asks for this
      // status while it runs and stops on it (worker/cancel.js), and a result
      // that already landed must not be overwritten by the stop that lost the race.
      await store.completeJob(userId, id, {
        status: 'cancelled',
        result: { error: 'Cancelled by the user.' },
        onlyIfOpen: true,
      });
      return {
        isError: true,
        content:
          'Stopped waiting for this at the user\'s request. If the machine had already started it, '
          + 'it may still have finished — check before assuming it did not happen.',
      };
    }
    await sleep(POLL_MS);
    const job = await store.getJob(userId, id);
    if (!job || job.status === 'pending' || job.status === 'running') continue;

    const result = job.result || {};
    if (job.status === 'error' || result.error) {
      return { isError: true, content: safeError(result.error) || 'The worker reported an error.' };
    }

    /**
     * The worker moved its workspace; remember where.
     *
     * The worker has no database of its own, so a change it makes lives only in
     * its memory and is lost the moment it restarts. Writing it to the device
     * row here is what makes "work in D:\projects from now on" mean *from now
     * on*, rather than until the next reboot — and it is the same field the app
     * writes, so both routes end up in one place.
     */
    if (name === 'set_workspace' && status.activeId) {
      await store
        .setDeviceWorkspace(userId, status.activeId, String(input?.path || '') || null)
        .catch(() => {});
    }

    // `shot` is a reference to an attachment the worker's result endpoint has
    // already stored — see `keepStepShot`. It rides out to the browser beside
    // the text, the same way `file` and `widget` do for cloud tools.
    return { isError: false, content: String(result.output ?? ''), shot: result.shot || undefined };
  }

  // Only if it is genuinely still open. The worker may have finished and be
  // posting its answer right now, and overwriting that with "Timed out." both
  // loses the result and tells the model to run the whole thing again.
  await store.completeJob(userId, id, {
    status: 'error',
    result: { error: 'Timed out.' },
    onlyIfOpen: true,
  });

  // Re-read before reporting: if the worker's answer landed during the grace
  // window, that is the truth and the timeout was a false alarm.
  const late = await store.getJob(userId, id).catch(() => null);
  if (late && late.status === 'done' && !late.result?.error) {
    return { isError: false, content: String(late.result?.output ?? ''), shot: late.result?.shot || undefined };
  }

  return {
    isError: true,
    content: `The worker did not answer within ${Math.round(timeoutMs / 1000)}s. It may be offline, or the command may have hung.`,
  };
}

/**
 * Which of these a caller actually has to supply.
 *
 * Written down because it was not: the agent loop passes all seven and the
 * workspace routes pass three, and both are correct — a person pressing Save in
 * their own file browser has no chat to attribute the call to, nothing to
 * abort it, no device hint and no deliverable to collect. Without the optional
 * markers those calls read as missing four required arguments.
 *
 * @typedef {{
 *   user: { id: string },
 *   name: string,
 *   input?: any,
 *   chatId?: string|null,
 *   signal?: AbortSignal,
 *   deviceHint?: string|null,
 *   deliverable?: any,
 *   answers?: any,
 *   raw?: boolean,
 * }} ToolCallArgs
 */

/**
 * What every branch hands back.
 *
 * Spelled out because the three optional fields are the ones that go missing:
 * `widget` was dropped by one branch and made two tools silently inert, and
 * `shot` had to be taught to a second branch after the first learned it. Naming
 * the shape once means the type checker notices the next time a branch forgets,
 * instead of a person noticing months later that a chart was never drawn.
 *
 * @typedef {{
 *   content: string,
 *   isError: boolean,
 *   file?: any,
 *   widget?: any,
 *   shot?: any,
 *   schedule?: any,
 *   answered?: string,
 * }} ToolResult
 */

/**
 * Run one tool call and return `{content, isError}` — never throws, because a
 * thrown error would break the agent loop where the model could otherwise read
 * the failure and adjust.
 *
 * @param {ToolCallArgs} args
 * @returns {Promise<ToolResult>}
 */
export async function executeTool(args) {
  /**
   * A tool call whose arguments did not parse is refused, not run.
   *
   * `openaiCompatible` assembles each call's arguments as a JSON *string* across
   * stream deltas and parses them itself, so a truncated reply lands here as
   * invalid JSON. It used to become `{ __unparsed: … }` and carry on: this
   * function checked the tool *name* and never the input *shape*, so the call
   * ran with every declared parameter `undefined`, and the tools' own defaults
   * turned a missing argument into a wide one — `resolveInWorkspace(undefined)`
   * resolves to the workspace root, so a cut-off `index_folder` indexed
   * everything and sent it to the embedding endpoint.
   *
   * Three of the five providers go through that adapter, and they are the two
   * aggregators this app is built around plus OpenAI itself.
   *
   * Refusing here rather than in the adapter keeps it at the same choke point as
   * the envelope below, so a future adapter that assembles its own arguments
   * inherits the refusal instead of having to remember it.
   *
   * The raw text is quoted back deliberately. A model told only "that failed"
   * tends to repeat the call; one shown the truncated fragment usually shortens
   * its arguments and succeeds.
   */
  const malformed = args?.input?.__malformed;
  if (malformed !== undefined) {
    return {
      isError: true,
      content:
        `The arguments for ${args?.name} were not valid JSON, so the call was not run. ` +
        'This usually means the reply was cut off mid-call. Send it again with shorter arguments' +
        (args?.name === 'update_file'
          ? ' — to change part of an existing file, do not resend it whole: pass edits, [{find, replace}], with only the parts that change. ' +
            'For a whole new version, write it in parts with append: true. '
          : args?.name === 'create_file'
            ? ' — for a long file, write the first part, then add the rest with update_file and append: true, a part at a time. '
            : '. ') +
        `What arrived was: ${String(malformed).slice(0, 200)}`,
    };
  }

  /*
   * Arguments checked against the tool's own schema before anything runs — what
   * provider-side strict mode would give, on every provider (GAP-004). Catalogue
   * tools only: an MCP server validates its own tools, and its schemas are
   * outside what `validate.js` is written to cover. See that file for what is
   * refused and what is merely coerced.
   */
  const def = TOOLS_BY_NAME[args?.name];
  let notes = [];
  if (def?.parameters) {
    const checked = validateArguments(def.parameters, args.input);
    if (!checked.ok) {
      return {
        isError: true,
        content: `The arguments for ${args.name} did not match what it takes, so it was not run: ${checked.error}`,
      };
    }
    args = { ...args, input: checked.input };
    notes = checked.notes || [];
  }

  let result = await runTool(args);
  // Said to the model, so it learns the value rather than repeating it.
  if (notes.length && !result?.isError) {
    const aside = `\n\n[${notes.join(' ')}]`;
    result = { ...result, content: `${result?.content ?? ''}${aside}` };
  }

  /**
   * One exit, and the envelope goes on here.
   *
   * Every other wrapping in this codebase happens at a call site — inside
   * `web_fetch`, inside search, inside the MCP branch below — and the pattern
   * failed exactly the way per-call-site rules do: the local branch and the
   * worker branch were each written without one, so a web page read through
   * `browser_look` reached the model as trusted text while the same page through
   * `web_fetch` was enveloped. `search_docs` was added to the wrapped set on the
   * explicit grounds that it was the last one missing. It was not.
   *
   * So this is the choke point. A tool named in `EXTERNAL_OUTPUT` gets the
   * envelope wherever it ran — cloud, in-process, or out on the worker — and a
   * new tool that returns somebody else's bytes is one line in a list rather
   * than a call site somebody has to remember.
   *
   * Errors are left alone. Their text is this application's, and `SEC-018` is
   * the separate question of what they may contain.
   *
   * `raw` is for the callers whose reader is not the model. The workspace routes
   * run these same tools to draw a file browser and **parse the output as JSON**
   * — an envelope round it is not a safety boundary there, it is a syntax error,
   * and the suite said so within a minute of this being written. That route
   * already opts out of the approval policy for the same underlying reason: a
   * person pressing Save has already decided, and a person reading their own
   * directory listing is not being told what to do by it.
   *
   * The default is to wrap. Forgetting `raw` costs a caller some noise;
   * forgetting to wrap is the bug this whole change exists to close, so the
   * safe direction is the one you get by saying nothing.
   */
  const wrapped =
    args?.raw || result?.isError || !returnsExternalContent(args?.name)
      ? result
      : (() => {
          const content = redactedOutput(args.name, String(result?.content ?? ''));
          return content.trim() ? { ...result, content: untrusted(externalSource(args.name, args.input), content) } : result;
        })();
  return withShotNote(wrapped, args);
}

/**
 * Say which file holds the step's screenshot.
 *
 * The picture was stored and shown to the person, and the model never learned
 * its id — so a model that cannot see had no way to ask what was on the screen
 * it had just driven to. One line, after the envelope and outside it: the id is
 * this app's, not the page's.
 */
function withShotNote(result, args) {
  const id = result?.shot?.id;
  if (!id || args?.raw || result?.isError) return result;
  return { ...result, content: `${result.content}\n[Screenshot of this step: file ${id} — look_at with that file_id reads what is on screen.]` };
}

/**
 * Tools whose output is scrubbed of recognisable credentials before the model
 * reads it (SEC-031).
 *
 * `clipboard_read` is read-only, so it never asks — right for "fix what I just
 * copied", and wrong for the other thing clipboards hold: the API key or token
 * somebody copied out of a dashboard a minute ago. Unprompted, that went to a
 * third-party model provider verbatim, and from there one `web_fetch` with it
 * in the query string is a leak no approval prompt would have seen. Asking on
 * every read would break the tool's whole purpose, so the recognisable shapes
 * are removed instead and the model is told what was taken out. An ordinary
 * password has no recognisable shape; that limit is real and not claimed away.
 */
const REDACTED_OUTPUT = new Set(['clipboard_read']);

/** @param {string} name @param {string} content */
export function redactedOutput(name, content) {
  if (!REDACTED_OUTPUT.has(name)) return content;
  const { text, found } = redactSecrets(content);
  if (!found.length) return content;
  return `${text}\n\n[${found.join(', ')} removed before this reached you. Tell the user it was not read, and ask them to paste the rest if they meant you to see it.]`;
}

/**
 * @param {ToolCallArgs} args
 * @returns {Promise<ToolResult>}
 */
async function runTool({ user, name, input, chatId, signal, deviceHint, deliverable, answers }) {
  const userId = user.id;

  /**
   * MCP tools are not in `TOOLS_BY_NAME`, and cannot be.
   *
   * They are discovered per account at the start of a turn, so the static
   * catalogue has never heard of them. Routed by prefix *before* the lookup
   * below, which would otherwise reject every one of them as unknown.
   */
  if (isMcpTool(name)) {
    try {
      const { text, isError } = await callMcpTool(userId, name, input || {}, Number(input?.timeout_ms) || undefined);
      /**
       * Wrapped, because this is code from outside the repository returning text
       * straight into the model's context. The tool is already graded
       * `sensitive` so a person sees the call — but they see the *call*, not
       * what it hands back, and what it hands back is the half that could carry
       * an instruction. See server/tools/untrusted.js.
       */
      return { isError, content: untrusted(`the ${splitMcpName(name)?.server || 'MCP'} server`, text) };
    } catch (err) {
      return { isError: true, content: `${name} failed: ${safeError(err) || String(err)}` };
    }
  }

  const def = TOOLS_BY_NAME[name];
  if (!def) return { isError: true, content: `Unknown tool "${name}".` };

  try {
    if (def.scope === 'cloud') {
      const impl = CLOUD_IMPLEMENTATIONS[name];
      if (!impl) return { isError: true, content: `Tool "${name}" has no implementation.` };
      // The whole user, not just the id: delegating to sub-agents needs the
      // account's model, preferences and worker, not merely a key to scope by.
      // `deliverable` is the set of tool names this account can actually be
      // given this turn. Only `load_tools` reads it, and only so it stops
      // promising tools that will never arrive — see loadToolsTool.
      const result = await impl(input || {}, { userId, user, chatId, signal, deliverable, answers });

      /**
       * A tool may hand back more than a sentence.
       *
       * `create_file` produces something the interface has to show — a card with
       * a preview and a download — and that cannot be expressed in the text the
       * model reads. So an implementation may return `{ content, file }`, and
       * the extra travels out with the tool result to the browser. Everything
       * else still returns a string and is untouched.
       */
      if (result && typeof result === 'object' && 'content' in result) {
        /**
         * `widget` travels too, and forgetting it made two whole tools inert.
         *
         * `chart` and `show_widget` both return `{ content, widget }` (see
         * cloud.js), the agent loop already attaches `widget` to the tool result
         * (agent.js), and the browser already draws `result.widget.markup`
         * (render.js). The plumbing existed at both ends and was cut exactly
         * here — the local branch below learned to forward `shot`, and this one
         * never learned about `widget`.
         *
         * The failure was invisible from the model's side, which is what made
         * it survive: `chart` answered "Drew the bar chart in the conversation.
         * The user can see it, so say what it shows rather than listing the
         * numbers again", so the model confidently described a picture that was
         * never drawn — not live, and not on reload.
         */
        return {
          isError: false,
          content: String(result.content ?? ''),
          file: result.file,
          widget: result.widget,
          // Standing work just set up (or found already set up) — drawn as a
          // card with a way into it. The third field this return has had to
          // learn; see the note on `widget` above for what forgetting one costs.
          schedule: result.schedule,
          // What the person answered on a question card, in their words.
          answered: result.answered,
        };
      }
      return { isError: false, content: String(result ?? '') };
    }

    // Running on the owner's own machine: no queue, no second process.
    if (usesInProcessTools(user)) {
      const impl = (await inProcessImplementations(user))[name];
      if (!impl) return { isError: true, content: `Tool "${name}" has no implementation.` };
      // The same second argument the worker passes, so a locally-run server and
      // a paired machine behave identically — a difference here would show up as
      // "it isolates conversations on my laptop but not on the VM".
      // `signal` too: on the owner's own machine there is no job to cancel, so the
      // tool itself has to hear the stop (AUTO-009).
      const output = await impl(input || {}, { chatId: chatId ?? null, signal });

      /**
       * The same two result shapes the worker's job runner handles.
       *
       * This branch is easy to forget and expensive to get wrong: the browser
       * tools return `{ text, shot }` now, and stringifying that object gives
       * the model "[object Object]" as its view of the page. The failure is
       * silent — the tool call succeeds — and it happens only on a locally-run
       * server, which is the configuration most people develop against.
       */
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        return {
          isError: false,
          content: String(output.text ?? ''),
          shot: output.shot ? await keepStepShot(userId, output.shot) : undefined,
        };
      }
      return { isError: false, content: String(output ?? '') };
    }

    /**
     * The server waits a little longer than the worker does.
     *
     * The worker kills a command at `timeout_ms` and only *then* serialises its
     * output and posts the result back. With both deadlines identical — which is
     * exactly what asking for the maximum produced — the server gave up while
     * that round trip was still in flight, overwrote the job with "Timed out.",
     * and told the model the command had not finished. It had. The worker's real
     * answer landed a moment later and was never read, and the model, told the
     * build had timed out, ran it again.
     */
    const GRACE_MS = 15_000;
    const timeoutMs =
      Math.min(Number(input?.timeout_ms) || DEFAULT_LOCAL_TIMEOUT_MS, 600_000) + GRACE_MS;
    return await runViaWorker({ user, userId, name, input: input || {}, chatId, timeoutMs, signal, deviceHint });
  } catch (err) {
    return { isError: true, content: `${name} failed: ${safeError(err) || String(err)}` };
  }
}
