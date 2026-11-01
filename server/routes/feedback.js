import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { sendEmail, senderName, publicUrl } from '../email.js';
import { composeMessage } from '../mailTemplate.js';
import { agentOf } from '../audit.js';
import { log } from '../util/trace.js';

/**
 * Give feedback (owner, 2026-10-31), the way Claude's works: an area, a kind,
 * what happened, how much it matters — and, only if the person switches it on,
 * a copy of one of their conversations as it is when sent.
 *
 * It goes to the deployment's administrators: kept for them to read in
 * Settings, and announced by email when the deployment can send one. It is
 * never read by a model. The privacy notice already says no one reads a
 * person's data unless they explicitly allow it — sending a conversation for
 * support is its own example — so the switch is that permission, given each
 * time.
 */

/** The choices the form offers, by the value it sends. Anything else is refused. */
export const FEEDBACK_CHOICES = {
  topic: ['files', 'connectors', 'web', 'scheduled', 'projects', 'artifacts', 'workflows', 'cloud', 'interface', 'limits', 'behaviour', 'refusal', 'other'],
  kind: ['bug', 'performance', 'feature'],
  affect: ['minor', 'workaround', 'blocks'],
  frequency: ['rare', 'weekly', 'daily'],
  worked: ['worked', 'unknown', 'never'],
};

/**
 * How much may be sent: enough to say what happened, not a way to store files.
 * And how many emails it may cause: an administrator's inbox is not a channel
 * anyone with an account gets to fill — past these, feedback is still kept and
 * read in Settings, only not announced.
 */
export const FEEDBACK_LIMITS = { body: 5000, other: 200, perHour: 10, transcriptMessages: 200, transcriptChars: 200_000, messageChars: 4000, mailsPerAccount: 3, mailsPerHour: 20 };

const HOUR_MS = 60 * 60_000;

const pick = (value, list) => (typeof value === 'string' && list.includes(value) ? value : null);

/**
 * What the form sent, checked field by field. The required ones — the area,
 * the kind, the words, how much it affects them — are refused when missing.
 *
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function checkFeedback(body) {
  const topic = pick(body?.topic, FEEDBACK_CHOICES.topic);
  const kind = pick(body?.kind, FEEDBACK_CHOICES.kind);
  const affect = pick(body?.affect, FEEDBACK_CHOICES.affect);
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  const other = typeof body?.topicOther === 'string' ? body.topicOther.trim().slice(0, FEEDBACK_LIMITS.other) : '';
  if (!topic || !kind || !affect) return { ok: false, error: 'Choose what this is about, what kind of feedback it is and how much it affects you.' };
  if (topic === 'other' && !other) return { ok: false, error: 'Say what this is about.' };
  if (!text) return { ok: false, error: 'Say what you expected, and what happened instead.' };
  if (text.length > FEEDBACK_LIMITS.body) return { ok: false, error: 'That is too long to send — keep it under 5,000 characters.' };
  return {
    ok: true,
    value: {
      topic,
      topicOther: topic === 'other' ? other : null,
      kind,
      body: text,
      affect,
      frequency: pick(body?.frequency, FEEDBACK_CHOICES.frequency),
      workedBefore: pick(body?.workedBefore, FEEDBACK_CHOICES.worked),
      chatId: typeof body?.chatId === 'string' && body.chatId ? body.chatId.slice(0, 80) : null,
    },
  };
}

/**
 * A conversation as an administrator reads it: who said what, in order, text
 * only — no files, no tool output — the newest messages kept when it is long.
 */
export function transcriptOf(messages) {
  const lines = (messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, text: String(m.text || '').slice(0, FEEDBACK_LIMITS.messageChars), at: m.createdAt || null }))
    .filter((m) => m.text.trim());
  let kept = lines.slice(-FEEDBACK_LIMITS.transcriptMessages);
  while (kept.length > 1 && kept.reduce((n, m) => n + m.text.length, 0) > FEEDBACK_LIMITS.transcriptChars) kept = kept.slice(1);
  return { messages: kept, cut: lines.length - kept.length };
}

/**
 * What can be wrong with one answer — Claude's list, in its order (owner,
 * 2026-11-02). The last but one is this deployment's usage policy, where
 * Claude's names its constitution.
 */
export const ANSWER_ISSUES = [
  'ui_bug', 'overactive_refusal', 'poor_image', 'not_followed', 'not_factual', 'incomplete',
  'thought_process', 'should_search', 'memory', 'report_content', 'usage_policy', 'other',
];

/** Feedback on one answer, checked: both the issue and the words are optional, as Claude's are. */
export function checkAnswerFeedback(body) {
  const given = typeof body?.issue === 'string' && body.issue ? body.issue : null;
  const issue = given ? pick(given, ANSWER_ISSUES) : null;
  if (given && !issue) return { ok: false, error: 'Choose one of the problems offered.' };
  const text = typeof body?.details === 'string' ? body.details.trim() : '';
  if (text.length > FEEDBACK_LIMITS.body) return { ok: false, error: 'That is too long to send — keep it under 5,000 characters.' };
  const chatId = typeof body?.chatId === 'string' && body.chatId ? body.chatId.slice(0, 80) : null;
  if (!chatId) return { ok: false, error: 'Say which conversation the answer is in.' };
  const messageId = typeof body?.messageId === 'string' && body.messageId ? body.messageId.slice(0, 80) : null;
  return { ok: true, value: { issue, body: text, chatId, messageId } };
}

/** How much of one turn is kept, piece by piece, and in all. */
const ANSWER_LIMITS = { prompt: 8000, text: 20_000, thinking: 8000, input: 4000, result: 6000, total: 300_000 };

const cut = (value, n) => {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > n ? `${text.slice(0, n)}… [${text.length - n} more characters]` : text;
};

/**
 * One turn as it ran, for the administrators who will fix what went wrong:
 * the message that began it, then each reply in order — its model, its
 * reasoning, the tools it called with what, and what each tool answered —
 * up to the next message the person sent. `afterId` is the message that
 * began it; without one, the conversation's last turn.
 */
export function answerSnapshot(messages, afterId) {
  const list = messages || [];
  let start = afterId ? list.findIndex((m) => m.id === afterId && m.role === 'user') : -1;
  if (start < 0) start = list.map((m) => m.role).lastIndexOf('user');
  if (start < 0) return null;
  const after = list.slice(start + 1);
  const stop = after.findIndex((m) => m.role === 'user');
  const turn = stop < 0 ? after : after.slice(0, stop);
  const prompt = list[start];
  const steps = turn.flatMap((m) => {
    if (m.role === 'assistant') {
      return [{
        kind: 'reply',
        model: m.model || null,
        at: m.createdAt || null,
        text: cut(m.text, ANSWER_LIMITS.text),
        thinking: m.thinking ? cut(m.thinking, ANSWER_LIMITS.thinking) : null,
        calls: (m.toolCalls || []).map((c) => ({ id: c.id || null, name: c.name, input: cut(c.input ?? {}, ANSWER_LIMITS.input) })),
        usage: m.usage || null,
        stop: m.stop || m.stopReason || null,
      }];
    }
    if (m.role === 'tool') {
      return [{
        kind: 'results',
        results: (m.results || []).map((r) => ({ id: r.toolCallId || null, name: r.name || null, error: !!r.isError, ms: r.ms ?? null, content: cut(r.content, ANSWER_LIMITS.result) })),
      }];
    }
    return [{ kind: m.role, text: cut(m.text ?? m, 2000) }];
  });
  // Too long in all: the tools' answers are the first thing shortened — the
  // replies and the calls say most about what went wrong.
  let size = JSON.stringify(steps).length;
  for (const step of steps) {
    if (size <= ANSWER_LIMITS.total) break;
    for (const r of step.results || []) {
      const before = r.content.length;
      r.content = cut(r.content, 500);
      size -= before - r.content.length;
    }
  }
  return {
    prompt: {
      id: prompt.id,
      at: prompt.createdAt || null,
      text: cut(prompt.text, ANSWER_LIMITS.prompt),
      files: (prompt.attachments || []).map((a) => a?.name).filter(Boolean),
    },
    steps,
  };
}

/**
 * The announcement an administrator receives.
 *
 * Whatever the sender wrote is set as a block of plain text, never as
 * Markdown: their words reach the administrator as words, not as a link or a
 * heading in a mail that comes from this deployment. Who sent it is the
 * username, checked when it was chosen — never the free-form name.
 *
 * @returns {{ subject: string, markdown: string }}
 */
export function feedbackMail(user, value, url) {
  const who = user.username || 'An account';
  const words = [value.topicOther ? `About: ${value.topicOther}` : '', value.body.slice(0, 1200)]
    .filter(Boolean)
    .join('\n\n')
    // A line of backticks would close the block early and let the rest be Markdown.
    .replace(/`{3,}/g, "'''");
  if (value.topic === 'answer') {
    const issue = value.issue || 'no problem chosen';
    return {
      subject: `Feedback from ${who} on an answer: ${issue}`,
      markdown:
        `**${who}** flagged an answer — ${issue}.\n\n` +
        (words ? '```\n' + words + '\n```\n\n' : '') +
        `Read it, with that answer as it ran, in Synapsez → Settings → Feedback: ${url}`,
    };
  }
  return {
    subject: `Feedback from ${who}: ${value.kind} · ${value.topic}`,
    markdown:
      `**${who}** sent feedback — ${value.kind}, about ${value.topic}, affecting them: ${value.affect}.\n\n` +
      '```\n' + words + '\n```\n\n' +
      `Read it, and any conversation they included, in Synapsez → Settings → People: ${url}`,
  };
}

/** Tell each administrator, by email, that something was sent. A failure is logged, never the sender's problem. */
async function tellAdministrators(req, user, value) {
  try {
    const store = getStore();
    // Counted at once, so a burst sent together cannot slip past the ceiling.
    const mine = await store.hitRateLimit(`feedback:mail:${user.id}`, FEEDBACK_LIMITS.mailsPerAccount, HOUR_MS);
    const all = mine.allowed ? await store.hitRateLimit('feedback:mail', FEEDBACK_LIMITS.mailsPerHour, HOUR_MS) : null;
    if (!all?.allowed) return;
    const admins = (await store.listUsers()).filter((u) => u.role === 'admin' && !u.suspended_at && u.email);
    if (!admins.length) return;
    const { subject, markdown } = feedbackMail(user, value, publicUrl(req));
    const mail = composeMessage({ brand: senderName(), subject, markdown, kind: 'announcement', language: 'en' });
    await sendEmail({ to: admins.map((a) => a.email), subject, html: mail.html, text: mail.text });
  } catch (err) {
    log.warn('feedback mail to administrators not sent', { error: String(err?.message || err).slice(0, 200) });
  }
}

/**
 * @param {import('express').Router} api    the authenticated router
 * @param {import('express').Router} admin  the administrators' router
 */
export function mountFeedbackRoutes(api, admin, { wrap }) {
  api.post(
    '/feedback',
    wrap(async (req, res) => {
      const store = getStore();
      const checked = checkFeedback(req.body);
      if (!checked.ok) return res.status(400).json({ error: /** @type {{ error: string }} */ (checked).error });
      // A ceiling on one account rather than on an address, so an office
      // behind one address is never turned away for the person beside them.
      // One upsert counts and checks together: ten sent at once are ten, not
      // ten each. A counter that cannot be reached lets feedback through.
      const counted = await store.hitRateLimit(`feedback:${req.user.id}`, FEEDBACK_LIMITS.perHour, HOUR_MS).catch((err) => {
        log.warn('feedback not counted — letting it through', { error: String(err?.message || err).slice(0, 200) });
        return null;
      });
      if (counted && !counted.allowed) {
        res.set('Retry-After', String(Math.ceil(counted.retryAfterMs / 1000)));
        return res.status(429).json({ error: 'You have sent a lot of feedback in the last hour. Try again a little later.' });
      }
      const value = checked.value;
      let chatTitle = null;
      let transcript = null;
      if (value.chatId) {
        // Their own conversation only: another account's id is not found.
        const chat = await store.getChat(req.user.id, value.chatId);
        if (!chat) return res.status(404).json({ error: 'That conversation was not found.' });
        // Incognito is a promise that nothing of it is kept — a copy for the
        // administrators included. The form never offers one; this is the lock.
        if (chat.incognito) return res.status(400).json({ error: 'An incognito conversation is not kept, so it cannot be included.' });
        chatTitle = String(chat.title || '').slice(0, 200) || null;
        transcript = transcriptOf(await store.listMessages(req.user.id, value.chatId));
      }
      const id = crypto.randomUUID();
      await store.createFeedback(req.user.id, {
        id,
        ...value,
        chatTitle,
        transcript,
        // What helps reproduce it, and nothing that identifies more than the account does.
        client: {
          language: typeof req.body?.language === 'string' ? req.body.language.slice(0, 8) : null,
          version: typeof req.body?.version === 'string' ? req.body.version.slice(0, 20) : null,
          browser: agentOf(req.headers['user-agent']),
        },
      });
      await tellAdministrators(req, req.user, value);
      res.status(201).json({ ok: true, id });
    }),
  );

  /**
   * Feedback on one answer (owner, 2026-11-02) — the button beside its copy
   * button. The conversation goes with it, as the dialog says before Submit,
   * and so does that turn as it ran: what the administrators need to find the
   * fault. Not for an incognito conversation, which keeps nothing: there the
   * words go alone.
   */
  api.post(
    '/feedback/answer',
    wrap(async (req, res) => {
      const store = getStore();
      const checked = checkAnswerFeedback(req.body);
      if (!checked.ok) return res.status(400).json({ error: /** @type {{ error: string }} */ (checked).error });
      const counted = await store.hitRateLimit(`feedback:${req.user.id}`, FEEDBACK_LIMITS.perHour, HOUR_MS).catch(() => null);
      if (counted && !counted.allowed) {
        res.set('Retry-After', String(Math.ceil(counted.retryAfterMs / 1000)));
        return res.status(429).json({ error: 'You have sent a lot of feedback in the last hour. Try again a little later.' });
      }
      const { issue, body, chatId, messageId } = checked.value;
      // Their own conversation only: another account's id is not found.
      const chat = await store.getChat(req.user.id, chatId);
      if (!chat) return res.status(404).json({ error: 'That conversation was not found.' });
      const messages = chat.incognito ? [] : await store.listMessages(req.user.id, chatId);
      const answer = chat.incognito ? null : answerSnapshot(messages, messageId);
      const value = {
        id: crypto.randomUUID(),
        topic: 'answer',
        kind: 'answer',
        affect: 'answer',
        body,
        issue,
        chatId,
        messageId: answer?.prompt?.id || messageId,
        chatTitle: chat.incognito ? null : String(chat.title || '').slice(0, 200) || null,
        transcript: chat.incognito ? null : transcriptOf(messages),
        answer,
        client: {
          language: typeof req.body?.language === 'string' ? req.body.language.slice(0, 8) : null,
          version: typeof req.body?.version === 'string' ? req.body.version.slice(0, 20) : null,
          browser: agentOf(req.headers['user-agent']),
        },
      };
      await store.createFeedback(req.user.id, value);
      await tellAdministrators(req, req.user, value);
      res.status(201).json({ ok: true, id: value.id, included: !chat.incognito });
    }),
  );

  admin.get(
    '/feedback',
    wrap(async (req, res) => {
      res.json({ feedback: await getStore().listFeedback(200) });
    }),
  );

  // A conversation sent with one, read when the administrator opens it — the
  // list only counts them. Gone once the conversation is deleted.
  admin.get(
    '/feedback/:id/transcript',
    wrap(async (req, res) => {
      const found = await getStore().getFeedbackTranscript(req.params.id);
      if (!found) return res.status(404).json({ error: 'That conversation was not found.' });
      res.json(found);
    }),
  );

  admin.put(
    '/feedback/:id/read',
    wrap(async (req, res) => {
      if (!(await getStore().markFeedbackRead(req.params.id))) return res.status(404).json({ error: 'That feedback was not found.' });
      res.json({ ok: true });
    }),
  );

  admin.delete(
    '/feedback/:id',
    wrap(async (req, res) => {
      if (!(await getStore().deleteFeedback(req.params.id))) return res.status(404).json({ error: 'That feedback was not found.' });
      res.json({ ok: true });
    }),
  );
}
