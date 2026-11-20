/**
 * Sending email for a person, from the deployment's mailbox.
 *
 * What a user asked for, and what this pins:
 *   - "email it to me" goes to the address they registered with, without the
 *     model having to know it;
 *   - any address, or several, they name instead;
 *   - the deployment's own name on the From line — a person's name there is
 *     what impersonation looks like, and it sent real mail to spam — with their
 *     address as Reply-To and a footer saying who sent it;
 *   - an HTML part beside the text, as an ordinary mail client sends;
 *   - Gmail configured with two variables;
 *   - and never "sent" when it was not — the provider refusing used to be
 *     reported as success, because `sendEmail` swallows errors by design.
 *
 * No mail leaves this machine: the SMTP transport is replaced with a recorder.
 *
 *   node test/email.test.mjs
 */
let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

for (const key of ['RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'GMAIL_USER', 'GMAIL_APP_PASSWORD']) {
  delete process.env[key];
}
process.env.ENCRYPTION_KEY ||= 'email-test-encryption-key';
process.env.SESSION_SECRET ||= 'email-test-session-secret';

const email = await import('../server/email.js');
const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
const { riskReason } = await import('../server/tools/definitions.js');
const send = CLOUD_IMPLEMENTATIONS.send_email;

const user = { id: 'u1', email: 'lan@example.com', name: 'Lan Nguyen' };
const sent = [];
let refuse = null;
const fakeTransport = {
  async sendMail(message) {
    if (refuse) throw new Error(refuse);
    sent.push(message);
    return { messageId: 'x' };
  },
};

const attempt = async (input, context = { user }) => {
  try {
    return { ok: true, result: await send(input, context) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

section('with no provider, nothing is claimed');
{
  const r = await attempt({ subject: 'Hi', body: 'Hello' });
  check('the tool refuses rather than pretending', !r.ok && /NOT sent/.test(r.error), r.error);
  check('and names the Gmail settings to add', /GMAIL_USER/.test(r.error) && /GMAIL_APP_PASSWORD/.test(r.error));
}

section('Gmail is two variables');
{
  process.env.GMAIL_USER = 'deployment.mailbox@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
  check('the backend is SMTP', email.emailBackend() === 'smtp', email.emailBackend());
  const settings = email.__testing.smtpSettings();
  check('on smtp.gmail.com over implicit TLS', settings.host === 'smtp.gmail.com' && settings.port === 465, JSON.stringify(settings.host));
  check('logged in as that mailbox', settings.user === 'deployment.mailbox@gmail.com');
  check('with the spaces Google shows removed from the password', settings.pass === 'abcdefghijklmnop');
  email.__testing.useTransport(fakeTransport);
}

section('"email it to me" goes to the address the account registered');
{
  sent.length = 0;
  const r = await attempt({ subject: 'Bản tin sáng', body: 'Nội dung' });
  check('it was sent', r.ok, r.error);
  check('to the account address', sent[0]?.to?.join() === 'lan@example.com', JSON.stringify(sent[0]?.to));
  check('from the deployment mailbox', (sent[0]?.from || '').endsWith('<deployment.mailbox@gmail.com>'), sent[0]?.from);
  check("with the deployment's own name on the From line, not the person's", sent[0]?.from === '"Ephapse" <deployment.mailbox@gmail.com>', sent[0]?.from);
  check('a footer in the text names who sent it, in the language of the message', /Người gửi Lan Nguyen · Ephapse/.test(sent[0]?.text || ''), sent[0]?.text);
  // Sent to the person themself here, so the To line is theirs; everything else must not be.
  const shown = JSON.stringify({ from: sent[0]?.from, replyTo: sent[0]?.replyTo, html: sent[0]?.html, text: sent[0]?.text });
  check("the person's own address appears nowhere in what the recipient reads", !shown.includes('lan@example.com'));
  check('there is an HTML part too', /^<!doctype html>/.test(sent[0]?.html || ''), (sent[0]?.html || '').slice(0, 40));
  check('laid out with the subject as its title and the body inside', /<h1[^>]*>(?:<span[^>]*>)*Bản tin sáng(?:<\/span>)*<\/h1>/.test(sent[0]?.html || '') && /Nội dung/.test(sent[0]?.html || ''));
  check('and the sender named in the footer', /Người gửi <strong[^>]*>Lan Nguyen<\/strong>/.test(sent[0]?.html || ''));
  check('replies come back to the business, with no Reply-To of their own', sent[0]?.replyTo === undefined, sent[0]?.replyTo);
  check('the result says where it went and where replies go', /lan@example\.com/.test(r.result) && /replies come back to the Ephapse mailbox/.test(r.result), r.result);
  const logo = sent[0]?.attachments?.[0];
  check('the web logo is embedded, not linked', logo?.cid === 'brand-logo@mail' && logo?.contentType === 'image/png' && logo?.content?.length > 1000, JSON.stringify({ cid: logo?.cid, bytes: logo?.content?.length }));
  check('and the HTML points at it', (sent[0]?.html || '').includes('src="cid:brand-logo@mail"'));

  process.env.EMAIL_REPLY_TO = 'support@example.org';
  sent.length = 0;
  await attempt({ subject: 'S', body: 'B' });
  check('EMAIL_REPLY_TO names a mailbox for replies', sent[0]?.replyTo === 'support@example.org', sent[0]?.replyTo);
  delete process.env.EMAIL_REPLY_TO;
}

section('any address the user names, or several');
{
  sent.length = 0;
  await attempt({ to: 'someone@example.com', subject: 'S', body: 'B' });
  check('one named address', sent[0]?.to?.join() === 'someone@example.com', JSON.stringify(sent[0]?.to));

  sent.length = 0;
  await attempt({ to: 'a@example.com, b@example.org; Chị Hoa <hoa@example.net>', subject: 'S', body: 'B' });
  check('several, however they are separated', sent[0]?.to?.join() === 'a@example.com,b@example.org,hoa@example.net', JSON.stringify(sent[0]?.to));

  sent.length = 0;
  await attempt({ to: ['x@example.com', 'x@example.com'], subject: 'S', body: 'B' });
  check('a list works, and a repeated address is sent once', sent[0]?.to?.join() === 'x@example.com', JSON.stringify(sent[0]?.to));

  const notAnAddress = await attempt({ to: 'Lan', subject: 'S', body: 'B' });
  check('a name is not an address', !notAnAddress.ok && /not an email address/.test(notAnAddress.error), notAnAddress.error);

  const many = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`).join(',');
  const tooMany = await attempt({ to: many, subject: 'S', body: 'B' });
  check('more than ten recipients is refused', !tooMany.ok && /11 recipients/.test(tooMany.error), tooMany.error);

  const nobody = await attempt({ subject: 'S', body: 'B' }, { user: { id: 'u2' } });
  check('an account with no address must be given one', !nobody.ok && /Give the address/.test(nobody.error), nobody.error);
}

section('a name cannot write its own headers');
{
  process.env.EMAIL_FROM = 'Eve"\r\nBcc: victim@example.com <deployment.mailbox@gmail.com>';
  const from = email.__testing.fromHeader();
  check('quotes and line breaks in a configured name are stripped', !/[\r\n]/.test(from) && (from.match(/"/g) || []).length === 2, from);
  process.env.EMAIL_FROM = 'Công ty ABC <deployment.mailbox@gmail.com>';
  check('EMAIL_FROM names the sender', email.__testing.fromHeader() === '"Công ty ABC" <deployment.mailbox@gmail.com>', email.__testing.fromHeader());
  delete process.env.EMAIL_FROM;

  const reset = email.resetEmail('https://app.example/reset?t=abc&x=1', '123456');
  check('the reset mail uses the same layout, with the code', reset.html.startsWith('<!doctype html>') && reset.html.includes('>123456<'));
  check('and its link escaped into the button', reset.html.includes('href="https://app.example/reset?t=abc&amp;x=1"'));
}

// Production, 2026-11-19: GMAIL_USER held `Ephapse <support@ephapse.net>`, EMAIL_FROM had not
// reached Production, the login was used as a bare address, and Resend refused
// `"Ephapse" <Ephapse <support@ephapse.net>>` with a 422, so no confirmation code went out.
section('a sender written as "Name <address>" works from any setting, and a broken one is skipped (1.33.3)');
{
  const saved = { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD };
  const want = '"Ephapse" <support@ephapse.net>';
  const headers = [];
  const header = () => {
    const h = email.__testing.fromHeader();
    headers.push(h);
    return h;
  };
  // Every warning the logger prints, to check it names the setting and never its value.
  const printed = [];
  const quiet = { warn: console.warn, log: console.log, info: console.info, error: console.error };
  const listen = () => Object.assign(console, { warn: (...a) => printed.push(a.map(String).join(' ')), log: (...a) => printed.push(a.map(String).join(' ')), info: (...a) => printed.push(a.map(String).join(' ')), error: (...a) => printed.push(a.map(String).join(' ')) });
  const stopListening = () => Object.assign(console, quiet);

  try {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    for (const form of [
      'support@ephapse.net',
      'Ephapse <support@ephapse.net>',
      '"Ephapse" <support@ephapse.net>',
      '  Ephapse <support@ephapse.net>  \n',
      '\t"Ephapse"   <support@ephapse.net> ',
      '"Ephapse <support@ephapse.net>"',
      "'Ephapse <support@ephapse.net>'",
      '"support@ephapse.net"',
      '<support@ephapse.net>',
    ]) {
      process.env.EMAIL_FROM = form;
      check(`EMAIL_FROM ${JSON.stringify(form)} gives ${want}`, header() === want, headers.at(-1));
    }
    check('  and the address check is given the bare address', email.senderAddress() === 'support@ephapse.net', email.senderAddress());
    check('  and the footer names Ephapse', email.senderName() === 'Ephapse', email.senderName());
    delete process.env.EMAIL_FROM;

    process.env.GMAIL_USER = 'Ephapse <support@ephapse.net>';
    process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
    check('GMAIL_USER written as "Ephapse <support@ephapse.net>", with no EMAIL_FROM, gives the same header', header() === want, headers.at(-1));
    check('  and Gmail is logged in to with the bare address', email.__testing.smtpSettings().user === 'support@ephapse.net', email.__testing.smtpSettings().user);
    check('  and the address check is given the bare address', email.senderAddress() === 'support@ephapse.net', email.senderAddress());

    // The incident itself, replayed: Resend chosen, the sender from GMAIL_USER.
    process.env.RESEND_API_KEY = 're_test_not_a_key';
    const realFetch = globalThis.fetch;
    let asked = null;
    globalThis.fetch = async (url, init) => {
      asked = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ id: 'r-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    listen();
    let sentToResend;
    try {
      sentToResend = await email.sendEmail({ to: 'lan@example.com', subject: 'Mã xác nhận', text: '123456' });
    } finally {
      stopListening();
      globalThis.fetch = realFetch;
      delete process.env.RESEND_API_KEY;
    }
    check('the confirmation mail goes to Resend with the from it accepts', sentToResend.ok && asked?.body?.from === want, `${asked?.body?.from} ${sentToResend.error || ''}`);
    headers.push(asked?.body?.from || '');

    const { checkDomain } = await import('../server/domainCheck.js');
    const names = [];
    const dns = async (url) => {
      const u = new URL(String(url));
      if (u.searchParams.get('name')) names.push(u.searchParams.get('name'));
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ Status: 0, Answer: [] }) };
    };
    const seen = await checkDomain({ url: 'https://app.example', mailFrom: email.senderAddress(), fetchImpl: dns });
    const mailCheck = seen.checks.find((c) => c.id === 'mail');
    check('the domain check reads the sender domain as ephapse.net', mailCheck?.facts?.domain === 'ephapse.net' && names.includes('_dmarc.ephapse.net') && !names.some((n) => /[<>"\s]/.test(n)), JSON.stringify({ facts: mailCheck?.facts, names }));

    // An unusable EMAIL_FROM is skipped for the next source, with one warning that names the setting only.
    process.env.GMAIL_USER = 'Ephapse <mailbox@ephapse.net>';
    for (const bad of ['Ephapse <support@ephapse.net', 'Ephapse', 'a b@c.d', 'Ephapse\n<support@ephapse.net>', 'support@ephapse.net\r\nBcc: victim@example.com', 'Ephapse <Ephapse <support@ephapse.net>>', 'support@localhost', 'two@at@ephapse.net']) {
      process.env.EMAIL_FROM = bad;
      printed.length = 0;
      listen();
      let h;
      try {
        h = header();
        // Asked again, as every mail asks several times: still one warning.
        email.senderName();
        email.__testing.fromHeader();
      } finally {
        stopListening();
      }
      const said = printed.join('\n');
      check(`an unusable EMAIL_FROM ${JSON.stringify(bad)} falls back to GMAIL_USER`, h === '"Ephapse" <mailbox@ephapse.net>', h);
      check('  with one warning naming EMAIL_FROM', printed.length === 1 && /EMAIL_FROM/.test(said), said);
      const pieces = [bad, ...bad.split(/[\s<>"]+/).filter((p) => p.length > 2)];
      check('  that never prints the value or a piece of it', !pieces.some((p) => said.includes(p)), said);
    }
    delete process.env.EMAIL_FROM;

    // The same for an unusable login: the last fallback, Resend's test sender.
    process.env.GMAIL_USER = 'Ephapse <mailbox@ephapse.net';
    printed.length = 0;
    listen();
    let fallback;
    try {
      fallback = header();
    } finally {
      stopListening();
    }
    check('an unusable GMAIL_USER falls back to Resend\'s test sender', fallback === '"Ephapse" <onboarding@resend.dev>', fallback);
    check('  with one warning naming GMAIL_USER and not its value', printed.length === 1 && /GMAIL_USER/.test(printed.join('')) && !/mailbox@ephapse\.net|Ephapse </.test(printed.join('')), printed.join(' | '));

    // An SMTP login that is a user name, not an address, is a login only: no sender, no warning.
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    Object.assign(process.env, { SMTP_HOST: 'smtp.example.org', SMTP_USER: 'apikey', SMTP_PASS: 'x' });
    printed.length = 0;
    listen();
    let apikey;
    try {
      apikey = header();
    } finally {
      stopListening();
    }
    check('an SMTP login that is a user name is kept for the login and not used as the sender', apikey === '"Ephapse" <onboarding@resend.dev>' && email.__testing.smtpSettings().user === 'apikey' && printed.length === 0, `${apikey} ${printed.join(' | ')}`);
    process.env.SMTP_USER = '"Acme Mail" <hello@acme.example>';
    check('an SMTP_USER written with a name is read the same way, for the sender and the login', header() === '"Acme Mail" <hello@acme.example>' && email.__testing.smtpSettings().user === 'hello@acme.example', `${headers.at(-1)} ${email.__testing.smtpSettings().user}`);
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[key];

    // Whatever the settings hold, the header is one name and one bare address.
    const hostile = ['Ephapse <Ephapse <support@ephapse.net>>', '<<a@b.co>>', 'A <a@b.co> <c@d.co>', '"><script>@x.co', 'x@y.co>', '<x@y.co', 'N "<a@b.co>"', '', '   ', `a@b.co${String.fromCharCode(0x2028)}Bcc: c@d.co`];
    for (const from of hostile) {
      for (const user of hostile) {
        process.env.EMAIL_FROM = from;
        Object.assign(process.env, { GMAIL_USER: user || 'x', GMAIL_APP_PASSWORD: 'p' });
        listen();
        try {
          header();
        } finally {
          stopListening();
        }
      }
    }
    const nested = headers.filter((h) => /<[^>]*</.test(h));
    check(`no header ever nests one address inside another (${headers.length} headers)`, nested.length === 0, nested.slice(0, 3).join(' | '));
    const shaped = headers.filter((h) => !/^"[^"<>\r\n]+" <[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+>$/.test(h));
    check('  every one is "Name" <one bare address>', shaped.length === 0, shaped.slice(0, 3).join(' | '));
  } finally {
    stopListening();
    delete process.env.EMAIL_FROM;
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'RESEND_API_KEY']) delete process.env[key];
    Object.assign(process.env, { GMAIL_USER: saved.user, GMAIL_APP_PASSWORD: saved.pass });
    email.__testing.useTransport(fakeTransport);
  }
}

section('a refusal from the provider is reported as a refusal');
{
  refuse = 'Invalid login: 535-5.7.8 Username and Password not accepted';
  const r = await attempt({ subject: 'S', body: 'B' });
  check('the tool fails', !r.ok, r.result);
  check('saying it was NOT sent, with the reason', /NOT sent/.test(r.error || '') && /535/.test(r.error || ''), r.error);
  refuse = null;
}

section('what the mail server said is kept, and a refused recipient is not "sent"');
{
  // nodemailer resolves even when the server refused recipients; it lists them.
  const saying = (info) => ({
    async sendMail(message) {
      sent.push(message);
      return info;
    },
  });

  email.__testing.useTransport(saying({ messageId: '<abc@gmail.com>', accepted: ['a@example.com'], rejected: [], response: '250 2.0.0 OK 1726 - gsmtp' }));
  const ok = await attempt({ to: 'a@example.com', subject: 'S', body: 'B' });
  check('the Message-ID is in the result, to find it in Sent', /<abc@gmail\.com>/.test(ok.result || ''), ok.result);
  check("and the server's own reply", /250 2\.0\.0 OK/.test(ok.result || ''));
  check('and it says accepted, not delivered', /accepted/.test(ok.result || '') && /Spam/.test(ok.result || ''));

  email.__testing.useTransport(saying({ messageId: '<m@x>', accepted: ['a@example.com'], rejected: ['typo@exmaple.con'], response: '250 OK' }));
  const partial = await attempt({ to: 'a@example.com, typo@exmaple.con', subject: 'S', body: 'B' });
  check('a partly refused send names who did not get it', partial.ok && /REFUSED typo@exmaple\.con/.test(partial.result), partial.result);

  email.__testing.useTransport(saying({ messageId: '<m@x>', accepted: [], rejected: ['nobody@exmaple.con'], response: '550 5.1.1 no such user' }));
  const none = await attempt({ to: 'nobody@exmaple.con', subject: 'S', body: 'B' });
  check('every recipient refused is NOT sent', !none.ok && /NOT sent/.test(none.error) && /550/.test(none.error), none.error);

  email.__testing.useTransport(fakeTransport);
}

section('the approval prompt says who it goes to');
{
  check('a named recipient is named', riskReason('send_email', { to: 'a@example.com' }) === 'Sends an email to a@example.com. It cannot be unsent.');
  check('and an empty one is the account itself', /your own account address/.test(riskReason('send_email', {}) || ''), riskReason('send_email', {}));
}

section('a deployment with no mail provider logs no mail');
{
  // A reset link in a host's logs is an account takeover for whoever reads them.
  const secret = 'https://app.example/reset?token=SECRET-TOKEN-123';
  const printed = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, out: process.stdout.write };
  const keep = (...a) => { printed.push(a.map(String).join(' ')); };
  const mailbox = { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD };
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  process.env.VERCEL = '1';
  Object.assign(console, { log: keep, warn: keep, error: keep, info: keep });
  process.stdout.write = (chunk) => { printed.push(String(chunk)); return true; };
  try {
    await email.sendEmail({ to: 'lan@example.com', subject: 'Reset', text: `Open ${secret}` });
  } finally {
    Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error, info: saved.info });
    process.stdout.write = saved.out;
    delete process.env.VERCEL;
    if (mailbox.user) Object.assign(process.env, { GMAIL_USER: mailbox.user, GMAIL_APP_PASSWORD: mailbox.pass });
  }
  const all = printed.join('\n');
  check('the body is not logged', !all.includes('SECRET-TOKEN-123'));
  check('  nor the address', !all.includes('lan@example.com'));
  check('  but the failure to send is', /no mail provider/.test(all), all.slice(0, 120));
}

section('the password-reset email is in the language of the person asking');
{
  const vi = email.resetEmail('https://app.example/?reset=t', '482913', 'vi');
  check('a Vietnamese subject, body and plain text', /^482913 là mã đặt lại mật khẩu .+ của bạn$/.test(vi.subject) && vi.html.includes('Đặt mật khẩu mới') && /hết hạn sau một giờ/.test(vi.text), vi.subject);
  const en = email.resetEmail('https://app.example/?reset=t', '482913');
  check('English by default', /^482913 is your .+ password reset code$/.test(en.subject) && en.html.includes('Choose a new password'));
  const { mailLanguage } = await import('../server/auth.js');
  const nobody = { id: 'u-no-prefs-here' };
  check('with no language chosen in the app, the browser asking decides', (await mailLanguage(nobody, { headers: { 'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8' } })) === 'vi');
  check('  and anything else is English', (await mailLanguage(nobody, { headers: { 'accept-language': 'fr-FR' } })) === 'en' && (await mailLanguage(nobody, {})) === 'en');
}

/*
 * The mailbox send_email uses also sends every sign-in and confirmation code: past the
 * provider's daily limit it is suspended and nobody can sign in (owner, 2026-11-12). So the
 * assistant's sends are counted in recipients, per account and for the deployment.
 */
section('a daily line on how many people the assistant may email');
{
  const { PGlite } = await import('@electric-sql/pglite');
  const { initStore } = await import('../server/store/index.js');
  const db = await PGlite.create();
  await initStore({ driver: { query: async (text, params = []) => (await db.query(text, params)).rows } });
  Object.assign(process.env, { GMAIL_USER: 'deployment.mailbox@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' });
  email.__testing.useTransport(fakeTransport);
  refuse = null;
  const ten = (n) => Array.from({ length: 10 }, (_, i) => `p${n}-${i}@example.com`).join(',');
  const heavy = { id: 'u-heavy', email: 'heavy@example.com', name: 'H' };
  sent.length = 0;
  const results = [];
  for (let n = 0; n < 5; n += 1) results.push(await attempt({ to: ten(n), subject: `Batch ${n}`, body: 'x' }, { user: heavy }));
  check('forty people in a day go out', results.slice(0, 4).every((r) => r.ok) && sent.length === 4, JSON.stringify(results.map((r) => r.ok)));
  check('  the forty-first is refused, said as the daily limit, and nothing is sent', !results[4].ok && /NOT sent/.test(results[4].error) && /daily limit/.test(results[4].error) && sent.length === 4, results[4].error);
  check('  another account still has its own line', (await attempt({ to: 'one@example.com', subject: 'Other', body: 'x' }, { user: { id: 'u-light', email: 'l@example.com' } })).ok);

  refuse = 'mailbox full';
  const failed = await attempt({ to: 'refund@example.com', subject: 'Fails', body: 'x' }, { user: { id: 'u-refund', email: 'r@example.com' } });
  refuse = null;
  const { readCounter } = (await import('../server/store/index.js')).getStore();
  const today = new Date().toISOString().slice(0, 10);
  check('a send the provider refused gives its recipients back', !failed.ok && (await readCounter(`mail:tool:u-refund:${today}`)) === 0, failed.error);

  // The deployment's line: Gmail's 300 a day, the rest of its 500 left for sign-in codes.
  const store = (await import('../server/store/index.js')).getStore();
  const { periodOf } = await import('../server/freeTier.js');
  await store.addToCounter(`mail:tool:${today}`, 295, periodOf('day').ends);
  const blocked = await attempt({ to: ten(9), subject: 'Over the deployment line', body: 'x' }, { user: { id: 'u-fresh', email: 'f@example.com' } });
  check("past the deployment's line, refused for everyone, saying the mailbox also sends sign-in codes", !blocked.ok && /sign-in codes/.test(blocked.error), blocked.error);
  check('  and the account it was refused for is not charged for it', (await readCounter(`mail:tool:u-fresh:${today}`)) === 0);
  await db.close();
}

console.log(failures === 0 ? '\n\x1b[32mAll email checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
