import { googleApi } from '../google.js';
import { getStore } from '../store/index.js';
import { extractPdfText } from '../pdf.js';
import { untrusted } from './untrusted.js';

/**
 * The Google tools — one per product, each with an `action`.
 *
 * One tool per product rather than one per call keeps the catalogue small
 * (eight schemas, not forty) and matches how a person thinks about it: "in my
 * calendar", "in Drive". Reads are graded ordinary and writes sensitive, per
 * action — see `assessRisk` — so listing next week's meetings runs at once
 * and sending an email or deleting an event is always shown first.
 *
 * Anything that came *from* Google and was written by somebody else — an
 * email body, a document, a form answer — comes back inside the untrusted
 * envelope: an email is the easiest way there is to put instructions in front
 * of a model.
 */

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const FORMS = 'https://forms.googleapis.com/v1/forms';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const PEOPLE = 'https://people.googleapis.com/v1';

const clip = (text, max = 20_000) =>
  text.length > max ? `${text.slice(0, max)}\n\n[truncated — ${text.length - max} more characters]` : text;
const need = (value, what) => {
  if (value === undefined || value === null || value === '') throw new Error(`Give ${what}.`);
  return value;
};
const list = (value) => (Array.isArray(value) ? value : String(value || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

/* ── Gmail ─────────────────────────────────────────────────────────── */

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');
/** A header value in UTF-8 that every mail client decodes — "Tóm tắt" survives. */
const encodeHeader = (text) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`);
/** Header values cannot carry a line break: that is how extra headers are smuggled in. */
const oneLine = (text) => String(text || '').replace(/[\r\n]+/g, ' ').trim();

function mime({ to, cc, bcc, subject, body, html, inReplyTo, references }) {
  const headers = [
    `To: ${oneLine(list(to).join(', '))}`,
    cc ? `Cc: ${oneLine(list(cc).join(', '))}` : null,
    bcc ? `Bcc: ${oneLine(list(bcc).join(', '))}` : null,
    `Subject: ${encodeHeader(oneLine(subject))}`,
    inReplyTo ? `In-Reply-To: ${oneLine(inReplyTo)}` : null,
    references ? `References: ${oneLine(references)}` : null,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const plain = String(body || '');
  if (!html) {
    return [...headers, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(plain).toString('base64')].join('\r\n');
  }
  const boundary = `b_${Date.now().toString(36)}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(plain || String(html).replace(/<[^>]+>/g, ' ')).toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(html)).toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');
}

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

/** The readable text of a message: the plain part, or the HTML part stripped. */
function bodyText(part) {
  const decode = (data) => Buffer.from(String(data || ''), 'base64url').toString('utf8');
  const walk = (p, type) => {
    if (!p) return null;
    if (p.mimeType === type && p.body?.data) return decode(p.body.data);
    for (const child of p.parts || []) {
      const found = walk(child, type);
      if (found) return found;
    }
    return null;
  };
  const plain = walk(part, 'text/plain');
  if (plain) return plain;
  const html = walk(part, 'text/html');
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const attachmentsOf = (part, out = []) => {
  if (part?.filename && part.body?.attachmentId) out.push(`${part.filename} (${part.mimeType})`);
  for (const child of part?.parts || []) attachmentsOf(child, out);
  return out;
};

async function gmailTool(input, { userId }) {
  const { action } = input;
  if (action === 'search') {
    const max = Math.min(Math.max(Number(input.max) || 10, 1), 25);
    const found = await googleApi(userId, `${GMAIL}/messages`, { query: { q: input.query || '', maxResults: max } });
    const ids = (found.messages || []).map((m) => m.id);
    if (!ids.length) return `No emails match ${JSON.stringify(input.query || '(all)')}.`;
    const rows = await Promise.all(
      ids.map((id) =>
        googleApi(userId, `${GMAIL}/messages/${id}`, {
          query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
        }),
      ),
    );
    const text = rows
      .map(
        (m) =>
          `- id ${m.id} · ${header(m, 'Date')}\n  From: ${header(m, 'From')}\n  Subject: ${header(m, 'Subject')}\n  ${
            (m.labelIds || []).includes('UNREAD') ? '[unread] ' : ''
          }${m.snippet || ''}`,
      )
      .join('\n');
    return untrusted('Gmail', `${rows.length} email(s):\n${text}`);
  }
  if (action === 'read') {
    const m = await googleApi(userId, `${GMAIL}/messages/${need(input.id, 'the email id from a search')}`, { query: { format: 'full' } });
    const files = attachmentsOf(m.payload);
    return untrusted(
      'Gmail',
      clip(
        `From: ${header(m, 'From')}\nTo: ${header(m, 'To')}\nCc: ${header(m, 'Cc')}\nDate: ${header(m, 'Date')}\nSubject: ${header(
          m,
          'Subject',
        )}\nThread: ${m.threadId}\n${files.length ? `Attachments: ${files.join(', ')}\n` : ''}\n${bodyText(m.payload)}`,
      ),
    );
  }
  if (action === 'send' || action === 'draft') {
    need(input.to, 'who it goes to (to)');
    let threadId;
    let inReplyTo;
    let references;
    let subject = input.subject;
    if (input.reply_to_id) {
      const original = await googleApi(userId, `${GMAIL}/messages/${input.reply_to_id}`, {
        query: { format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'Subject'] },
      });
      threadId = original.threadId;
      inReplyTo = header(original, 'Message-ID');
      references = [header(original, 'References'), inReplyTo].filter(Boolean).join(' ');
      subject ||= /^re:/i.test(header(original, 'Subject')) ? header(original, 'Subject') : `Re: ${header(original, 'Subject')}`;
    }
    need(subject, 'a subject');
    const raw = b64url(mime({ ...input, subject, inReplyTo, references }));
    const message = { raw, ...(threadId ? { threadId } : {}) };
    if (action === 'draft') {
      const draft = await googleApi(userId, `${GMAIL}/drafts`, { method: 'POST', json: { message } });
      return `Draft saved in Gmail (draft id ${draft.id}) — to ${list(input.to).join(', ')}, "${subject}". It has not been sent.`;
    }
    const sent = await googleApi(userId, `${GMAIL}/messages/send`, { method: 'POST', json: message });
    return `Sent from Gmail to ${list(input.to).join(', ')} — "${subject}" (message id ${sent.id}).`;
  }
  if (action === 'modify') {
    const labels = await googleApi(userId, `${GMAIL}/labels`);
    const byName = (name) => {
      const upper = String(name).toUpperCase();
      return labels.labels?.find((l) => l.id === upper || l.name.toLowerCase() === String(name).toLowerCase())?.id || name;
    };
    const add = list(input.add_labels).map(byName);
    const remove = list(input.remove_labels).map(byName);
    await googleApi(userId, `${GMAIL}/messages/${need(input.id, 'the email id')}/modify`, {
      method: 'POST',
      json: { addLabelIds: add, removeLabelIds: remove },
    });
    return `Updated email ${input.id}: added ${add.join(', ') || 'nothing'}, removed ${remove.join(', ') || 'nothing'}.`;
  }
  if (action === 'trash') {
    await googleApi(userId, `${GMAIL}/messages/${need(input.id, 'the email id')}/trash`, { method: 'POST' });
    return `Moved email ${input.id} to the Trash (recoverable for 30 days).`;
  }
  if (action === 'labels') {
    const labels = await googleApi(userId, `${GMAIL}/labels`);
    return (labels.labels || []).map((l) => `- ${l.name} (${l.id})`).join('\n') || 'No labels.';
  }
  throw new Error('action is search, read, send, draft, modify, trash or labels.');
}

/* ── Calendar ──────────────────────────────────────────────────────── */

/** A time the model wrote, as the event body wants it: a date for all-day, a dateTime otherwise. */
function when(value, tz, allDay) {
  const text = String(need(value, 'a start and end time'));
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(text)) return { date: text.slice(0, 10) };
  return { dateTime: /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.length === 16 ? `${text}:00` : text, ...(tz ? { timeZone: tz } : {}) };
}

const describeEvent = (e) =>
  `- ${e.summary || '(no title)'} · ${e.start?.dateTime || e.start?.date} → ${e.end?.dateTime || e.end?.date}${
    e.location ? ` · ${e.location}` : ''
  }${e.hangoutLink ? ` · Meet ${e.hangoutLink}` : ''}${e.attendees?.length ? ` · with ${e.attendees.map((a) => a.email).join(', ')}` : ''} (id ${e.id})`;

async function calendarTool(input, { userId }) {
  const { action } = input;
  const cal = encodeURIComponent(input.calendar_id || 'primary');
  if (action === 'list') {
    const from = input.time_min ? new Date(input.time_min) : new Date();
    const to = input.time_max ? new Date(input.time_max) : new Date(from.getTime() + 7 * 86_400_000);
    const found = await googleApi(userId, `${CAL}/calendars/${cal}/events`, {
      query: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        q: input.query,
        maxResults: Math.min(Number(input.max) || 50, 250),
        timeZone: input.tz,
      },
    });
    const items = found.items || [];
    if (!items.length) return `Nothing on the calendar between ${from.toISOString()} and ${to.toISOString()}.`;
    return untrusted('Google Calendar', `${items.length} event(s), calendar time zone ${found.timeZone}:\n${items.map(describeEvent).join('\n')}`);
  }
  if (action === 'calendars') {
    const found = await googleApi(userId, `${CAL}/users/me/calendarList`);
    return (found.items || []).map((c) => `- ${c.summary}${c.primary ? ' (primary)' : ''} — id ${c.id}, ${c.timeZone}`).join('\n');
  }
  if (action === 'create' || action === 'update') {
    const body = {};
    if (input.summary !== undefined) body.summary = input.summary;
    if (input.description !== undefined) body.description = input.description;
    if (input.location !== undefined) body.location = input.location;
    if (input.start) body.start = when(input.start, input.tz, input.all_day);
    if (input.end) body.end = when(input.end, input.tz, input.all_day);
    if (input.attendees) body.attendees = list(input.attendees).map((email) => ({ email }));
    if (input.reminder_minutes !== undefined) {
      body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: Number(input.reminder_minutes) }] };
    }
    if (input.recurrence) body.recurrence = list(input.recurrence);
    const query = { sendUpdates: input.attendees ? 'all' : 'none' };
    if (input.meet) {
      body.conferenceData = { createRequest: { requestId: `m${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      query.conferenceDataVersion = 1;
    }
    const e =
      action === 'create'
        ? await googleApi(userId, `${CAL}/calendars/${cal}/events`, {
            method: 'POST',
            query,
            json: { ...body, summary: need(body.summary, 'a title (summary)'), start: need(body.start, 'start'), end: need(body.end, 'end') },
          })
        : await googleApi(userId, `${CAL}/calendars/${cal}/events/${encodeURIComponent(need(input.event_id, 'the event id'))}`, {
            method: 'PATCH',
            query,
            json: body,
          });
    return `${action === 'create' ? 'Created' : 'Updated'}: ${describeEvent(e).slice(2)}\nLink: ${e.htmlLink}`;
  }
  if (action === 'delete') {
    await googleApi(userId, `${CAL}/calendars/${cal}/events/${encodeURIComponent(need(input.event_id, 'the event id'))}`, {
      method: 'DELETE',
    });
    return `Deleted event ${input.event_id}.`;
  }
  if (action === 'free_busy') {
    const from = input.time_min ? new Date(input.time_min) : new Date();
    const to = input.time_max ? new Date(input.time_max) : new Date(from.getTime() + 86_400_000);
    const ids = list(input.calendars || 'primary');
    const found = await googleApi(userId, `${CAL}/freeBusy`, {
      method: 'POST',
      json: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: ids.map((id) => ({ id })) },
    });
    return Object.entries(found.calendars || {})
      .map(([id, c]) => `${id}: ${c.busy?.length ? c.busy.map((b) => `${b.start}→${b.end}`).join(', ') : 'free the whole time'}`)
      .join('\n');
  }
  throw new Error('action is list, calendars, create, update, delete or free_busy.');
}

/* ── Drive ─────────────────────────────────────────────────────────── */

const GOOGLE_TYPES = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
  folder: 'application/vnd.google-apps.folder',
};
const EXPORT_AS = {
  [GOOGLE_TYPES.doc]: 'text/plain',
  [GOOGLE_TYPES.sheet]: 'text/csv',
  [GOOGLE_TYPES.slides]: 'text/plain',
  'application/vnd.google-apps.drawing': 'image/svg+xml',
};

/** A file's text, whatever it is, or null when it has none to give. */
async function driveText(userId, id) {
  const meta = await googleApi(userId, `${DRIVE}/files/${encodeURIComponent(id)}`, {
    query: { fields: 'id,name,mimeType,size,webViewLink,modifiedTime', supportsAllDrives: 'true' },
  });
  let text = null;
  if (EXPORT_AS[meta.mimeType]) {
    const res = await googleApi(userId, `${DRIVE}/files/${encodeURIComponent(id)}/export`, {
      query: { mimeType: EXPORT_AS[meta.mimeType] },
      raw: true,
    });
    text = await res.text();
  } else if (/^text\/|json|xml|csv|javascript/.test(meta.mimeType) || meta.mimeType === 'application/pdf') {
    if (Number(meta.size) > 25 * 1024 * 1024) return { meta, text: null };
    const res = await googleApi(userId, `${DRIVE}/files/${encodeURIComponent(id)}`, { query: { alt: 'media', supportsAllDrives: 'true' }, raw: true });
    const bytes = Buffer.from(await res.arrayBuffer());
    text = meta.mimeType === 'application/pdf' ? (await extractPdfText(bytes))?.text ?? null : bytes.toString('utf8');
  }
  return { meta, text };
}

/** A multipart upload: metadata and content in one request, converted to a Google type when asked. */
async function driveUpload(userId, { metadata, content, contentType }) {
  const boundary = `u_${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8'), tail]);
  return googleApi(userId, UPLOAD, {
    method: 'POST',
    query: { uploadType: 'multipart', fields: 'id,name,mimeType,webViewLink', supportsAllDrives: 'true' },
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

/** Quote a value for a Drive query. */
const dq = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function driveTool(input, { userId }) {
  const { action } = input;
  if (action === 'search') {
    const parts = ['trashed = false'];
    if (input.query) parts.push(`(name contains ${dq(input.query)} or fullText contains ${dq(input.query)})`);
    if (input.type && GOOGLE_TYPES[input.type]) parts.push(`mimeType = ${dq(GOOGLE_TYPES[input.type])}`);
    if (input.folder_id) parts.push(`${dq(input.folder_id)} in parents`);
    const found = await googleApi(userId, `${DRIVE}/files`, {
      query: {
        q: input.raw_query || parts.join(' and '),
        pageSize: Math.min(Number(input.max) || 20, 100),
        orderBy: input.query ? undefined : 'modifiedTime desc',
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress))',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      },
    });
    const files = found.files || [];
    if (!files.length) return 'No files found.';
    return files.map((f) => `- ${f.name} · ${f.mimeType.replace('application/vnd.google-apps.', 'google ')} · ${f.modifiedTime} · id ${f.id}\n  ${f.webViewLink}`).join('\n');
  }
  if (action === 'read') {
    const { meta, text } = await driveText(userId, need(input.file_id, 'the file id'));
    if (text === null) return `${meta.name} (${meta.mimeType}) has no text to read here. Link: ${meta.webViewLink}`;
    return untrusted(`Google Drive: ${meta.name}`, clip(`${meta.name} — ${meta.webViewLink}\n\n${text}`));
  }
  if (action === 'create') {
    const kind = input.as || 'doc';
    const name = need(input.name, 'a file name');
    if (kind === 'folder') {
      const f = await googleApi(userId, `${DRIVE}/files`, {
        method: 'POST',
        query: { fields: 'id,name,webViewLink', supportsAllDrives: 'true' },
        json: { name, mimeType: GOOGLE_TYPES.folder, ...(input.folder_id ? { parents: [input.folder_id] } : {}) },
      });
      return `Created folder "${f.name}" — ${f.webViewLink} (id ${f.id}).`;
    }
    // HTML becomes a formatted Google Doc; CSV becomes a Sheet.
    const html = /<\w+[^>]*>/.test(String(input.content || ''));
    const contentType = kind === 'sheet' ? 'text/csv' : kind === 'doc' ? (html ? 'text/html' : 'text/plain') : input.mime_type || 'text/plain';
    const f = await driveUpload(userId, {
      metadata: {
        name,
        ...(GOOGLE_TYPES[kind] ? { mimeType: GOOGLE_TYPES[kind] } : {}),
        ...(input.folder_id ? { parents: [input.folder_id] } : {}),
      },
      content: input.content || '',
      contentType,
    });
    return `Created "${f.name}" in Google Drive — ${f.webViewLink} (id ${f.id}).`;
  }
  if (action === 'upload') {
    const file = await getStore().getAttachment(userId, String(need(input.attachment_id, 'the attachment id of a file in this conversation')));
    if (!file) throw new Error(`No file with the id "${input.attachment_id}" on this account.`);
    const f = await driveUpload(userId, {
      metadata: { name: input.name || file.name, ...(input.folder_id ? { parents: [input.folder_id] } : {}) },
      content: Buffer.from(String(file.data || ''), 'base64'),
      contentType: file.mime || 'application/octet-stream',
    });
    return `Uploaded "${f.name}" to Google Drive — ${f.webViewLink} (id ${f.id}).`;
  }
  if (action === 'share') {
    const role = ['reader', 'commenter', 'writer'].includes(input.role) ? input.role : 'reader';
    const target = input.email ? { type: 'user', emailAddress: input.email } : { type: 'anyone' };
    await googleApi(userId, `${DRIVE}/files/${encodeURIComponent(need(input.file_id, 'the file id'))}/permissions`, {
      method: 'POST',
      query: { sendNotificationEmail: input.email ? 'true' : undefined, supportsAllDrives: 'true' },
      json: { role, ...target },
    });
    return `Shared ${input.file_id} as ${role} with ${input.email || 'anyone who has the link'}.`;
  }
  if (action === 'move' || action === 'rename') {
    const id = encodeURIComponent(need(input.file_id, 'the file id'));
    const query = { supportsAllDrives: 'true', fields: 'id,name,parents,webViewLink' };
    if (action === 'move') {
      const meta = await googleApi(userId, `${DRIVE}/files/${id}`, { query: { fields: 'parents', supportsAllDrives: 'true' } });
      query.addParents = need(input.folder_id, 'the folder to move it into');
      query.removeParents = (meta.parents || []).join(',');
    }
    const f = await googleApi(userId, `${DRIVE}/files/${id}`, {
      method: 'PATCH',
      query,
      json: action === 'rename' ? { name: need(input.name, 'the new name') } : {},
    });
    return `${action === 'move' ? 'Moved' : 'Renamed'}: ${f.name} — ${f.webViewLink}`;
  }
  if (action === 'trash') {
    await googleApi(userId, `${DRIVE}/files/${encodeURIComponent(need(input.file_id, 'the file id'))}`, {
      method: 'PATCH',
      query: { supportsAllDrives: 'true' },
      json: { trashed: true },
    });
    return `Moved ${input.file_id} to the Drive trash (recoverable for 30 days).`;
  }
  throw new Error('action is search, read, create, upload, share, move, rename or trash.');
}

/* ── Docs ──────────────────────────────────────────────────────────── */

function docText(doc) {
  const out = [];
  const walk = (content) => {
    for (const el of content || []) {
      if (el.paragraph) out.push((el.paragraph.elements || []).map((e) => e.textRun?.content || '').join(''));
      if (el.table) for (const row of el.table.tableRows || []) for (const cell of row.tableCells || []) walk(cell.content);
    }
  };
  walk(doc.body?.content);
  return out.join('').trim();
}

async function docsTool(input, { userId }) {
  const { action } = input;
  if (action === 'read') {
    const doc = await googleApi(userId, `${DOCS}/${encodeURIComponent(need(input.document_id, 'the document id'))}`);
    return untrusted(`Google Docs: ${doc.title}`, clip(`${doc.title}\nhttps://docs.google.com/document/d/${doc.documentId}/edit\n\n${docText(doc)}`));
  }
  if (action === 'create') {
    // Through Drive, so HTML headings, lists and tables arrive formatted.
    return driveTool({ action: 'create', as: 'doc', name: need(input.title, 'a title'), content: input.content || '', folder_id: input.folder_id }, { userId });
  }
  if (action === 'append' || action === 'replace') {
    const id = encodeURIComponent(need(input.document_id, 'the document id'));
    const requests =
      action === 'append'
        ? [{ insertText: { endOfSegmentLocation: {}, text: `\n${need(input.text, 'the text to add')}` } }]
        : [{ replaceAllText: { containsText: { text: need(input.find, 'the text to find'), matchCase: true }, replaceText: String(input.text ?? '') } }];
    const result = await googleApi(userId, `${DOCS}/${id}:batchUpdate`, { method: 'POST', json: { requests } });
    const replaced = result.replies?.[0]?.replaceAllText?.occurrencesChanged;
    return action === 'append' ? `Added the text to the end of the document.` : `Replaced ${replaced ?? 0} occurrence(s).`;
  }
  throw new Error('action is read, create, append or replace.');
}

/* ── Sheets ────────────────────────────────────────────────────────── */

const csvRow = (row) => row.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',');

async function sheetsTool(input, { userId }) {
  const { action } = input;
  const id = () => encodeURIComponent(need(input.spreadsheet_id, 'the spreadsheet id'));
  if (action === 'info') {
    const s = await googleApi(userId, `${SHEETS}/${id()}`, { query: { fields: 'properties.title,spreadsheetUrl,sheets.properties' } });
    return `${s.properties.title} — ${s.spreadsheetUrl}\n${(s.sheets || [])
      .map((sh) => `- ${sh.properties.title}: ${sh.properties.gridProperties?.rowCount} rows × ${sh.properties.gridProperties?.columnCount} columns`)
      .join('\n')}`;
  }
  if (action === 'read') {
    const range = input.range || 'A1:Z1000';
    const v = await googleApi(userId, `${SHEETS}/${id()}/values/${encodeURIComponent(range)}`, {
      query: { valueRenderOption: input.formulas ? 'FORMULA' : 'FORMATTED_VALUE' },
    });
    const rows = v.values || [];
    return untrusted('Google Sheets', clip(`${v.range} — ${rows.length} row(s), as CSV:\n${rows.map(csvRow).join('\n')}`));
  }
  if (action === 'write' || action === 'append') {
    const values = need(input.values, 'values, as rows: [["a", 1], ["b", 2]]');
    if (!Array.isArray(values) || !values.every(Array.isArray)) throw new Error('values must be a list of rows, each a list of cells.');
    const range = encodeURIComponent(need(input.range, 'a range, e.g. Sheet1!A1'));
    const result =
      action === 'write'
        ? await googleApi(userId, `${SHEETS}/${id()}/values/${range}`, {
            method: 'PUT',
            query: { valueInputOption: 'USER_ENTERED' },
            json: { values },
          })
        : await googleApi(userId, `${SHEETS}/${id()}/values/${range}:append`, {
            method: 'POST',
            query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
            json: { values },
          });
    const updated = result.updates || result;
    return `${action === 'write' ? 'Wrote' : 'Appended'} ${updated.updatedRows ?? values.length} row(s) at ${updated.updatedRange || input.range}.`;
  }
  if (action === 'create') {
    const s = await googleApi(userId, SHEETS, {
      method: 'POST',
      json: {
        properties: { title: need(input.title, 'a title') },
        sheets: list(input.sheet_names || 'Sheet1').map((title) => ({ properties: { title } })),
      },
    });
    if (Array.isArray(input.values) && input.values.length) {
      const first = s.sheets?.[0]?.properties?.title || 'Sheet1';
      await googleApi(userId, `${SHEETS}/${s.spreadsheetId}/values/${encodeURIComponent(`${first}!A1`)}`, {
        method: 'PUT',
        query: { valueInputOption: 'USER_ENTERED' },
        json: { values: input.values },
      });
    }
    return `Created "${input.title}" — ${s.spreadsheetUrl} (id ${s.spreadsheetId}).`;
  }
  if (action === 'clear') {
    await googleApi(userId, `${SHEETS}/${id()}/values/${encodeURIComponent(need(input.range, 'the range to clear'))}:clear`, { method: 'POST', json: {} });
    return `Cleared ${input.range}.`;
  }
  throw new Error('action is info, read, write, append, create or clear.');
}

/* ── Forms ─────────────────────────────────────────────────────────── */

function formItem(q, index) {
  const type = q.type || 'text';
  const base = { title: need(q.title, `a title for question ${index + 1}`), ...(q.description ? { description: q.description } : {}) };
  const required = !!q.required;
  let question;
  if (type === 'text' || type === 'paragraph') question = { required, textQuestion: { paragraph: type === 'paragraph' } };
  else if (type === 'choice' || type === 'checkbox' || type === 'dropdown') {
    const options = list(q.options).map((value) => ({ value }));
    if (!options.length) throw new Error(`Question "${base.title}" needs options.`);
    question = { required, choiceQuestion: { type: { choice: 'RADIO', checkbox: 'CHECKBOX', dropdown: 'DROP_DOWN' }[type], options } };
  } else if (type === 'scale') question = { required, scaleQuestion: { low: Number(q.low ?? 1), high: Number(q.high ?? 5) } };
  else if (type === 'date') question = { required, dateQuestion: {} };
  else if (type === 'time') question = { required, timeQuestion: {} };
  else throw new Error(`"${type}" is not a question type. Use text, paragraph, choice, checkbox, dropdown, scale, date or time.`);
  return { ...base, questionItem: { question } };
}

async function formsTool(input, { userId }) {
  const { action } = input;
  if (action === 'create') {
    const form = await googleApi(userId, FORMS, { method: 'POST', json: { info: { title: need(input.title, 'a title'), documentTitle: input.title } } });
    const requests = [];
    if (input.description) requests.push({ updateFormInfo: { info: { description: input.description }, updateMask: 'description' } });
    (input.questions || []).forEach((q, i) => requests.push({ createItem: { item: formItem(q, i), location: { index: i } } }));
    if (requests.length) await googleApi(userId, `${FORMS}/${form.formId}:batchUpdate`, { method: 'POST', json: { requests } });
    return `Created the form "${input.title}" with ${(input.questions || []).length} question(s).\nShare with people: ${form.responderUri}\nEdit: https://docs.google.com/forms/d/${form.formId}/edit (id ${form.formId})`;
  }
  const id = encodeURIComponent(need(input.form_id, 'the form id'));
  if (action === 'get') {
    const form = await googleApi(userId, `${FORMS}/${id}`);
    const items = (form.items || []).map((it, i) => `${i + 1}. ${it.title}${it.questionItem?.question?.required ? ' *' : ''}`).join('\n');
    return `${form.info?.title}\n${form.responderUri}\n${items}`;
  }
  if (action === 'responses') {
    const [form, found] = await Promise.all([googleApi(userId, `${FORMS}/${id}`), googleApi(userId, `${FORMS}/${id}/responses`)]);
    const titles = Object.fromEntries(
      (form.items || []).filter((it) => it.questionItem).map((it) => [it.questionItem.question.questionId, it.title]),
    );
    const responses = found.responses || [];
    if (!responses.length) return `No responses yet to "${form.info?.title}".`;
    const text = responses
      .map(
        (r, i) =>
          `Response ${i + 1} (${r.lastSubmittedTime}${r.respondentEmail ? `, ${r.respondentEmail}` : ''}):\n${Object.entries(r.answers || {})
            .map(([qid, a]) => `  ${titles[qid] || qid}: ${(a.textAnswers?.answers || []).map((x) => x.value).join(', ')}`)
            .join('\n')}`,
      )
      .join('\n');
    return untrusted('Google Forms responses', clip(`${responses.length} response(s) to "${form.info?.title}":\n${text}`));
  }
  if (action === 'add_questions') {
    const form = await googleApi(userId, `${FORMS}/${id}`);
    const start = (form.items || []).length;
    const requests = (input.questions || []).map((q, i) => ({ createItem: { item: formItem(q, i), location: { index: start + i } } }));
    await googleApi(userId, `${FORMS}/${id}:batchUpdate`, { method: 'POST', json: { requests } });
    return `Added ${requests.length} question(s).`;
  }
  throw new Error('action is create, get, responses or add_questions.');
}

/* ── Tasks ─────────────────────────────────────────────────────────── */

async function tasksTool(input, { userId }) {
  const { action } = input;
  const tl = encodeURIComponent(input.list_id || '@default');
  if (action === 'lists') {
    const found = await googleApi(userId, `${TASKS}/users/@me/lists`);
    return (found.items || []).map((l) => `- ${l.title} (id ${l.id})`).join('\n') || 'No task lists.';
  }
  if (action === 'list') {
    const found = await googleApi(userId, `${TASKS}/lists/${tl}/tasks`, {
      query: { showCompleted: input.show_completed ? 'true' : 'false', maxResults: 100 },
    });
    const items = found.items || [];
    if (!items.length) return 'No tasks.';
    return items.map((x) => `- [${x.status === 'completed' ? 'x' : ' '}] ${x.title}${x.due ? ` · due ${x.due.slice(0, 10)}` : ''}${x.notes ? ` — ${x.notes}` : ''} (id ${x.id})`).join('\n');
  }
  if (action === 'add') {
    const due = input.due ? `${String(input.due).slice(0, 10)}T00:00:00.000Z` : undefined;
    const x = await googleApi(userId, `${TASKS}/lists/${tl}/tasks`, {
      method: 'POST',
      json: { title: need(input.title, 'a title'), notes: input.notes, due },
    });
    return `Added "${x.title}"${due ? ` due ${due.slice(0, 10)}` : ''} (id ${x.id}).`;
  }
  if (action === 'complete') {
    await googleApi(userId, `${TASKS}/lists/${tl}/tasks/${encodeURIComponent(need(input.task_id, 'the task id'))}`, {
      method: 'PATCH',
      json: { status: 'completed' },
    });
    return `Marked ${input.task_id} as done.`;
  }
  if (action === 'delete') {
    await googleApi(userId, `${TASKS}/lists/${tl}/tasks/${encodeURIComponent(need(input.task_id, 'the task id'))}`, { method: 'DELETE' });
    return `Deleted task ${input.task_id}.`;
  }
  throw new Error('action is lists, list, add, complete or delete.');
}

/* ── Contacts ──────────────────────────────────────────────────────── */

const person = (p) =>
  `- ${p.names?.[0]?.displayName || '(no name)'}${p.emailAddresses?.length ? ` · ${p.emailAddresses.map((e) => e.value).join(', ')}` : ''}${
    p.phoneNumbers?.length ? ` · ${p.phoneNumbers.map((n) => n.value).join(', ')}` : ''
  }${p.organizations?.[0]?.name ? ` · ${p.organizations[0].name}` : ''}`;

async function contactsTool(input, { userId }) {
  const readMask = 'names,emailAddresses,phoneNumbers,organizations';
  if (input.action === 'search') {
    // Google asks for one empty search first to warm its index; without it
    // the first real one can come back empty.
    await googleApi(userId, `${PEOPLE}/people:searchContacts`, { query: { query: '', readMask } }).catch(() => {});
    const found = await googleApi(userId, `${PEOPLE}/people:searchContacts`, {
      query: { query: need(input.query, 'a name, email or phone to look for'), readMask, pageSize: 30 },
    });
    const people = (found.results || []).map((r) => r.person);
    return people.length ? people.map(person).join('\n') : `No contact matches ${JSON.stringify(input.query)}.`;
  }
  if (input.action === 'list') {
    const found = await googleApi(userId, `${PEOPLE}/people/me/connections`, {
      query: { personFields: readMask, pageSize: Math.min(Number(input.max) || 100, 1000), sortOrder: 'FIRST_NAME_ASCENDING' },
    });
    return (found.connections || []).map(person).join('\n') || 'No contacts.';
  }
  throw new Error('action is search or list.');
}

/**
 * A file from this app, put in the person's Drive — the viewer's "Save to
 * Google Drive". Word, Excel and PowerPoint files are converted to Docs, Sheets
 * and Slides, so the copy opens and edits in Google's editors rather than as a
 * download; everything else goes up as it is.
 */
const CONVERT_TO = {
  docx: GOOGLE_TYPES.doc,
  xlsx: GOOGLE_TYPES.sheet,
  pptx: GOOGLE_TYPES.slides,
  csv: GOOGLE_TYPES.sheet,
};
export async function saveToDrive(userId, file) {
  const ext = String(file.name).split('.').pop().toLowerCase();
  const target = CONVERT_TO[ext];
  return driveUpload(userId, {
    metadata: { name: target ? String(file.name).replace(/\.[^.]+$/, '') : file.name, ...(target ? { mimeType: target } : {}) },
    content: Buffer.from(String(file.data || ''), 'base64'),
    contentType: file.mime || 'application/octet-stream',
  });
}

export const GOOGLE_IMPLEMENTATIONS = {
  gmail: gmailTool,
  google_calendar: calendarTool,
  google_drive: driveTool,
  google_docs: docsTool,
  google_sheets: sheetsTool,
  google_forms: formsTool,
  google_tasks: tasksTool,
  google_contacts: contactsTool,
};

export const __testing = { mime, bodyText, docText, when, formItem, encodeHeader, oneLine };
