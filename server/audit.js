import { getStore } from './store/index.js';
import { log } from './util/trace.js';

/**
 * The account's security record: what happened to it, never what was said in it.
 *
 * An owner who wonders "was that me?" needs three things — what happened, when,
 * and roughly from where — and nothing more. So an event carries its kind, a
 * small detail object (which provider a key was for, how many conversations an
 * import brought in), the network the request came from and the browser family.
 * Never message text, never a secret, never a full address: an IPv4 address is
 * cut to its /24 and an IPv6 one to its /48, which tells a phone on the home
 * Wi-Fi from a login on another continent without keeping where somebody lives.
 *
 * Recording is best-effort by design. An audit write that fails must not fail
 * the sign-in or the export it describes — that would turn a logging blip into
 * an outage — so it is logged and dropped.
 */

/** The kinds of event, and the words the Activity list uses for each. */
export const AUDIT_KINDS = [
  'sign_in', 'sign_in_failed', 'password_changed', 'password_reset', 'two_factor_on', 'two_factor_off',
  'key_added', 'key_removed', 'data_exported', 'data_imported', 'memory_cleared', 'chat_shared',
  'chat_unshared', 'settings_privacy', 'account_deleted_user', 'consent_given',
];

/** The network a request came from, never the address itself. */
export function networkOf(ip) {
  let value = String(ip || '').trim();
  if (!value) return null;
  // An IPv4 address carried in IPv6 notation is an IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1];
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(value);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (value.includes(':')) {
    const head = value.split('%')[0].split('::')[0].split(':').filter(Boolean).slice(0, 3);
    while (head.length < 3) head.push('0');
    return `${head.join(':')}::/48`;
  }
  return null;
}

/** "Chrome on Windows" — the family, not the fingerprint a full user agent is. */
export function agentOf(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : /curl|node|python|axios|fetch/i.test(ua) ? 'A script'
                : 'A browser';
  const system =
    /Windows/.test(ua) ? 'Windows'
      : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
        : /Android/.test(ua) ? 'Android'
          : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux'
              : null;
  return system ? `${browser} on ${system}` : browser;
}

/**
 * Record one event. Never throws.
 *
 * @param req     the request it happened on, for the network and browser; may be null
 * @param userId  whose account
 * @param kind    one of AUDIT_KINDS
 * @param detail  small, and free of anything private — see the header
 */
export async function audit(req, userId, kind, detail = {}) {
  if (!userId || !AUDIT_KINDS.includes(kind)) return;
  try {
    await getStore().recordAudit(userId, {
      kind,
      detail,
      network: networkOf(req?.ip),
      agent: agentOf(req?.headers?.['user-agent']),
    });
  } catch (err) {
    log.warn('audit event not recorded', { kind, error: String(err?.message || err).slice(0, 200) });
  }
}
