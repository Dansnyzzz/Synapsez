/**
 * Whether a site's address is safe from spoofing, checked live (server/domainCheck.js):
 * DNSSEC, HTTPS and HSTS, the preload list, CAA, and the sending address's email
 * protection. The same check as Settings → System → Address safety.
 *
 *   npm run domain:check                         PUBLIC_URL, and the mail sender if set
 *   npm run domain:check -- https://example.com you@example.com
 */
import { checkDomain } from '../server/domainCheck.js';
import { emailBackend, parseMailbox, senderMailbox } from '../server/email.js';

const [url = process.env.PUBLIC_URL || '', typed] = process.argv.slice(2);

// The sender the app itself sends from (1.33.3 review): its own settings in its own order
// (EMAIL_FROM, then SMTP_USER with SMTP_HOST or GMAIL_USER with GMAIL_APP_PASSWORD), as
// Settings → System → Address safety reads it. One given on the command line wins.
const given = typed === undefined ? null : parseMailbox(typed);
const sender = senderMailbox();
const noProvider = emailBackend() === 'console';
const mailFrom = typed !== undefined ? given?.address || '' : noProvider ? '' : sender.address;

const result = await checkDomain({ url, mailFrom });
const marks = { ok: '✓', warn: '!', fail: '✕', unknown: '?' };
console.log(`\n${result.host || '(no site address: set PUBLIC_URL or give one)'} — checked ${result.checkedAt}\n`);
if (typed !== undefined) {
  console.log(given ? `  sender   ${given.address} (given)` : '  sender   the one given is not one usable address (addr@domain or Name <addr@domain>), so mail is not checked');
} else {
  // Named by the setting, never by its value.
  for (const name of sender.unusable) console.log(`  sender   ${name} is set but is not one usable address, so the app skips it`);
  if (noProvider) console.log('  sender   none: no mail provider is set up, so mail is not checked');
  else console.log(`  sender   ${sender.address} (from ${sender.source === 'default' ? "Resend's test sender, as nothing usable is set" : sender.source})`);
}
console.log('');
for (const check of result.checks) {
  console.log(`  ${marks[check.verdict] || '?'} ${check.id.padEnd(8)} ${check.verdict.padEnd(8)} ${JSON.stringify(check.facts)}`);
}
console.log('');
process.exit(result.checks.some((check) => check.verdict === 'fail') ? 1 : 0);
