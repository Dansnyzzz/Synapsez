/**
 * Conversations exported from somewhere else, read into one shape.
 *
 * Three sources, recognised by their structure rather than by a file name:
 *
 * - **Synapsez** — this app's own export (`format: "synapsez-export"`).
 * - **Claude** — `conversations.json` from claude.ai → Settings → Privacy →
 *   Export data: an array of `{ name, created_at, chat_messages: [{ sender,
 *   text | content[] }] }`.
 * - **ChatGPT** — `conversations.json` from its data export: an array of
 *   `{ title, create_time, mapping, current_node }`, where `mapping` is a tree of
 *   every branch ever tried and `current_node` is the leaf that was kept. Only
 *   that branch is read — the edits somebody abandoned are not the conversation.
 *
 * Shared by the browser, which reads the file and sends it up in pieces small
 * enough for a hosted function to accept, and the server, which runs the same
 * function again on what arrives — a browser is not a place to trust.
 *
 * Pure, and free of the DOM, so the suite can drive it with plain objects.
 */

export const IMPORT_LIMITS = {
  conversations: 5_000,
  messagesPerConversation: 2_000,
  messageChars: 100_000,
  titleChars: 200,
};

const asText = (value) => (typeof value === 'string' ? value : '');

/** An ISO time from whatever a source wrote: ISO text, or seconds since 1970. */
function isoTime(value) {
  if (value == null || value === '') return null;
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanTitle(title, messages) {
  const own = asText(title).replace(/\s+/g, ' ').trim();
  if (own) return own.slice(0, IMPORT_LIMITS.titleChars);
  const first = messages.find((m) => m.role === 'user')?.text || '';
  return first.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Imported conversation';
}

/** Only the two roles a transcript can replay, only text, bounded. */
function cleanMessages(list) {
  const out = [];
  for (const m of list) {
    if (out.length >= IMPORT_LIMITS.messagesPerConversation) break;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    const text = asText(m.text).replace(/\r\n/g, '\n').trim().slice(0, IMPORT_LIMITS.messageChars);
    if (!role || !text) continue;
    out.push({ role, text, createdAt: isoTime(m.createdAt) });
  }
  return out;
}

function conversation({ title, createdAt, updatedAt, messages }) {
  const clean = cleanMessages(messages);
  if (!clean.length) return null;
  return {
    title: cleanTitle(title, clean),
    createdAt: isoTime(createdAt) || clean[0].createdAt || null,
    updatedAt: isoTime(updatedAt) || clean[clean.length - 1].createdAt || isoTime(createdAt) || null,
    messages: clean,
  };
}

/* ── each source ─────────────────────────────────────────────────────── */

function fromClaude(list) {
  return list.map((c) => {
    const messages = (Array.isArray(c?.chat_messages) ? c.chat_messages : []).map((m) => {
      // Newer exports carry the words in `content` blocks and leave `text`
      // empty; older ones are the other way round. Either is read.
      const blocks = Array.isArray(m?.content)
        ? m.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n')
        : '';
      return {
        role: m?.sender === 'human' ? 'user' : m?.sender === 'assistant' ? 'assistant' : null,
        text: asText(m?.text) || blocks,
        createdAt: m?.created_at,
      };
    });
    return conversation({ title: c?.name, createdAt: c?.created_at, updatedAt: c?.updated_at, messages });
  });
}

/** The branch ChatGPT kept: from the current leaf back to the root, then reversed. */
function chatgptBranch(mapping, leaf) {
  const path = [];
  const seen = new Set();
  let id = leaf;
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    path.push(mapping[id]);
    id = mapping[id].parent;
  }
  return path.reverse();
}

function fromChatGPT(list) {
  return list.map((c) => {
    const mapping = c?.mapping && typeof c.mapping === 'object' ? c.mapping : {};
    let leaf = c?.current_node;
    if (!leaf || !mapping[leaf]) {
      // No recorded leaf: follow the first child from the root, which is the
      // thread as it was first written.
      const root = Object.keys(mapping).find((k) => !mapping[k]?.parent);
      leaf = root;
      // A file is somebody else's output; one whose children loop back must not
      // hang the tab (CODE-035), the same guard chatgptBranch keeps.
      const walked = new Set();
      while (leaf && mapping[leaf]?.children?.length && !walked.has(leaf)) {
        walked.add(leaf);
        leaf = mapping[leaf].children[0];
      }
    }
    const messages = chatgptBranch(mapping, leaf)
      .map((node) => node?.message)
      .filter(Boolean)
      .map((msg) => {
        const parts = Array.isArray(msg?.content?.parts) ? msg.content.parts : [];
        const text = parts.filter((p) => typeof p === 'string').join('\n\n') || asText(msg?.content?.text);
        return { role: msg?.author?.role, text, createdAt: msg?.create_time };
      });
    return conversation({ title: c?.title, createdAt: c?.create_time, updatedAt: c?.update_time, messages });
  });
}

function fromSynapsez(data) {
  return (Array.isArray(data?.chats) ? data.chats : []).map((c) =>
    conversation({
      title: c?.title,
      createdAt: c?.created_at ?? c?.createdAt,
      updatedAt: c?.updated_at ?? c?.updatedAt,
      messages: (Array.isArray(c?.messages) ? c.messages : []).map((m) => ({
        role: m?.role,
        text: m?.text,
        createdAt: m?.created_at ?? m?.createdAt,
      })),
    }),
  );
}

/** Which source this is, or null when it is none of them. */
export function detectSource(data) {
  if (data && !Array.isArray(data) && data.format === 'synapsez-export') return 'synapsez';
  if (Array.isArray(data) && data.length) {
    const sample = data.find((c) => c && typeof c === 'object');
    if (sample && Array.isArray(sample.chat_messages)) return 'claude';
    if (sample && sample.mapping && typeof sample.mapping === 'object') return 'chatgpt';
  }
  if (Array.isArray(data) && !data.length) return 'empty';
  return null;
}

/**
 * Read an export into `{ source, conversations, memory }`.
 *
 * `memory` is only ever the account's own notes from a Synapsez export: a
 * project's notes belong to a project id that means nothing on another account.
 *
 * @throws when the data is none of the known shapes
 */
export function normaliseImport(data) {
  const source = detectSource(data);
  if (!source) {
    throw new Error('This file is not a conversation export this app can read. Use conversations.json from Claude or ChatGPT, or a Synapsez export.');
  }
  const read = source === 'claude' ? fromClaude(data) : source === 'chatgpt' ? fromChatGPT(data) : source === 'synapsez' ? fromSynapsez(data) : [];
  const conversations = read.filter(Boolean).slice(0, IMPORT_LIMITS.conversations);
  const memory =
    source === 'synapsez' && Array.isArray(data.memory)
      ? data.memory
          .filter((n) => n && n.scope === 'account' && typeof n.key === 'string' && typeof n.content === 'string')
          .map((n) => ({ key: n.key.trim().slice(0, 120), content: n.content.slice(0, 8_000) }))
          .filter((n) => n.key && n.content.trim())
      : [];
  return { source, conversations, memory };
}

/**
 * Cut conversations into batches no bigger than `maxBytes` of JSON, so each
 * request fits under a hosted function's body limit (4.5 MB on Vercel). A
 * single conversation bigger than that goes alone, trimmed from its start —
 * the end of a conversation is where it arrived, and the part most worth having.
 */
export function batchesOf(conversations, maxBytes = 3_000_000) {
  const batches = [];
  let current = [];
  let size = 2;
  const sizeOf = (c) => new TextEncoder().encode(JSON.stringify(c)).length + 1;
  for (const original of conversations) {
    let c = original;
    let bytes = sizeOf(c);
    while (bytes > maxBytes && c.messages.length > 1) {
      c = { ...c, messages: c.messages.slice(Math.ceil(c.messages.length / 4)) };
      bytes = sizeOf(c);
    }
    if (bytes > maxBytes) continue;
    if (current.length && (size + bytes > maxBytes || current.length >= 50)) {
      batches.push(current);
      current = [];
      size = 2;
    }
    current.push(c);
    size += bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}
