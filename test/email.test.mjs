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
  check("with the deployment's own name on the From line, not the person's", sent[0]?.from === '"Synapsez" <deployment.mailbox@gmail.com>', sent[0]?.from);
  check('a footer in the text names who sent it, in the language of the message', /Người gửi Lan Nguyen · Synapsez/.test(sent[0]?.text || ''), sent[0]?.text);
  // Sent to the person themself here, so the To line is theirs; everything else must not be.
  const shown = JSON.stringify({ from: sent[0]?.from, replyTo: sent[0]?.replyTo, html: sent[0]?.html, text: sent[0]?.text });
  check("the person's own address appears nowhere in what the recipient reads", !shown.includes('lan@example.com'));
  check('there is an HTML part too', /^<!doctype html>/.test(sent[0]?.html || ''), (sent[0]?.html || '').slice(0, 40));
  check('laid out with the subject as its title and the body inside', /<h1[^>]*>(?:<span[^>]*>)*Bản tin sáng(?:<\/span>)*<\/h1>/.test(sent[0]?.html || '') && /Nội dung/.test(sent[0]?.html || ''));
  check('and the sender named in the footer', /Người gửi <strong[^>]*>Lan Nguyen<\/strong>/.test(sent[0]?.html || ''));
  check('replies come back to the business, with no Reply-To of their own', sent[0]?.replyTo === undefined, sent[0]?.replyTo);
  check('the result says where it went and where replies go', /lan@example\.com/.test(r.result) && /replies come back to the Synapsez mailbox/.test(r.result), r.result);
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

console.log(failures === 0 ? '\n\x1b[32mAll email checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
