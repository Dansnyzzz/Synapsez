/**
 * Whether a site's address is safe from spoofing, checked live (server/domainCheck.js):
 * DNSSEC, HTTPS and HSTS, the preload list, CAA, and the sending address's email
 * protection. The same check as Settings → System → Address safety.
 *
 *   npm run domain:check                         PUBLIC_URL, and the mail sender if set
 *   npm run domain:check -- https://example.com you@example.com
 */
import { checkDomain } from '../server/domainCheck.js';
import { parseMailbox } from '../server/email.js';

const [url = process.env.PUBLIC_URL || '', typed] = process.argv.slice(2);
// Read the way the app reads a sender (1.33.3), so `Name <you@example.com>` checks example.com, not "example.com>".
const sender = typed !== undefined ? parseMailbox(typed) : parseMailbox(process.env.EMAIL_FROM) || parseMailbox(process.env.GMAIL_USER);
const mailFrom = sender?.address || '';
const result = await checkDomain({ url, mailFrom });
const marks = { ok: '✓', warn: '!', fail: '✕', unknown: '?' };
console.log(`\n${result.host || '(no address)'} — checked ${result.checkedAt}\n`);
for (const check of result.checks) {
  console.log(`  ${marks[check.verdict] || '?'} ${check.id.padEnd(8)} ${check.verdict.padEnd(8)} ${JSON.stringify(check.facts)}`);
}
console.log('');
process.exit(result.checks.some((check) => check.verdict === 'fail') ? 1 : 0);
