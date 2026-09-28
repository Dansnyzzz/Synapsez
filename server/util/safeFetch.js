import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

/**
 * Fetching a URL the model chose, without handing it the inside of the network.
 *
 * `web_fetch` looks like the most harmless tool in the list and is the most
 * dangerous one to leave open, because the model does not have to be malicious
 * to misuse it — a page it reads can tell it what to fetch next. On a hosted
 * deployment that reaches the cloud metadata service, which hands out
 * credentials to anyone who asks from inside. On somebody's laptop it reaches
 * their router, their NAS, and every admin panel on their Wi-Fi.
 *
 * So: resolve the name first, refuse anything that lands on a private address,
 * and re-check on every redirect — because a public hostname that 302s to
 * 169.254.169.254 defeats a check done only on the URL you were given.
 */

const MAX_REDIRECTS = 5;

/** An IPv6 address (already validated by `net.isIPv6`) as its eight 16-bit words. */
function ipv6Words(address) {
  let text = address.toLowerCase();
  // A trailing dotted quad is the last two words written in decimal.
  const quad = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(fill).fill('0'), ...right].map((h) => parseInt(h, 16));
}

/** Address ranges that are not the public internet. */
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  const bare = String(address).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv6(bare)) {
    /*
     * Judged on the eight numbers, never on the spelling.
     *
     * The URL parser rewrites `[::ffff:169.254.169.254]` as `[::ffff:a9fe:a9fe]`,
     * so a check that matched the dotted form let every IPv4-mapped address
     * through — cloud metadata and localhost included. The same address has many
     * spellings; it has one value.
     */
    const w = ipv6Words(bare);
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const zeroTo = (n) => w.slice(0, n).every((x) => x === 0);
    if (zeroTo(7) && w[7] <= 1) return true; // unspecified, loopback
    if (zeroTo(5) && w[5] === 0xffff) return isPrivateAddress(v4(w[6], w[7])); // IPv4-mapped
    if (zeroTo(6)) return true; // IPv4-compatible, deprecated and never public
    if (w[0] === 0x64 && w[1] === 0xff9b) {
      // NAT64: the well-known prefix carries a real IPv4 address; the local-use one is private.
      return w.slice(2, 6).every((x) => x === 0) ? isPrivateAddress(v4(w[6], w[7])) : true;
    }
    if (w[0] === 0x2002) return isPrivateAddress(v4(w[1], w[2])); // 6to4
    if (w[0] === 0x2001 && w[1] === 0) return true; // Teredo — the address inside is obscured
    if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
    if (w[0] === 0x100 && zeroTo(4)) return true; // discard-only
    if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true; // link- and site-local
    if ((w[0] & 0xfe00) === 0xfc00) return true; // unique local
    if ((w[0] & 0xff00) === 0xff00) return true; // multicast
    return false;
  }

  // Not an address we can reason about; refuse rather than guess.
  return true;
}

/**
 * Check one hop. Throws with a message the model can act on rather than retry.
 *
 * Set `ALLOW_PRIVATE_FETCH=true` when the whole point is to reach something on
 * the local network — an internal wiki, a service on the same host. It is off by
 * default because the safe case has to be the one you get without deciding.
 */
export async function assertPublic(url) {
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Only http and https URLs can be fetched — "${url.protocol}" is not one.`);
  }
  if (/^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_FETCH || '')) return null;

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // A literal address needs no lookup, and must not get one.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`${host} is a private address. This tool only reaches the public internet.`);
    }
    return null;
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve "${host}".`);
  }
  if (!records.length) throw new Error(`Could not resolve "${host}".`);

  // Every record, not just the first: a name that resolves to one public and one
  // private address is the textbook way round a check that stops at [0].
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new Error(
        `"${host}" resolves to the private address ${address}. This tool only reaches the public internet.`,
      );
    }
  }

  /**
   * The verified answer goes back to the caller, and that is the point.
   *
   * Checking a name and then handing the *name* to something that resolves it
   * again is a time-of-check/time-of-use gap, and it is the standard way past a
   * guard like this one: a record with a one-second TTL answers with a public
   * address for the check and `169.254.169.254` for the connection a moment
   * later. Every careful thing above — reading all the records, re-checking each
   * redirect — rested on a second lookup nobody controlled.
   *
   * So the connection is pinned to what was actually verified. See `safeFetch`.
   */
  return records;
}

/**
 * One request, to an address that has already been checked.
 *
 * `node:https` rather than `fetch`, and the reason is the `lookup` option. Node's
 * `fetch` gives no way to say which address to connect to, so a verified name is
 * handed back to a resolver that answers again, independently — which is the
 * gap this whole module exists to close. `http.request` passes `lookup` down to
 * the socket, so the connection goes to the address that was actually checked.
 *
 * The URL is still what is passed in, so TLS SNI and the `Host` header are the
 * hostname rather than the IP: connecting by address alone would break every
 * virtual-hosted site and every certificate.
 *
 * The response is shaped like a `fetch` response in the four ways this codebase
 * uses one — `ok`, `status`, `statusText`, `headers.get()` — plus `text()` and a
 * `body` that is the Node stream, which both callers already iterate.
 */
/**
 * Let a Node response stream answer `getReader()` as well.
 *
 * The two original callers iterate `body` with `for await`, which an
 * `IncomingMessage` supports natively. The MCP transport does not: it reads
 * Server-Sent Events with `body.getReader()`, the WHATWG shape, because it was
 * written against the global `fetch`. Moving it onto this module — which is the
 * point, since `fetch` cannot be pinned to a checked address — would otherwise
 * mean rewriting its stream loop, and that loop has no test behind it.
 *
 * So the stream grows the one method, rather than the consumer being rewritten
 * blind. `read()` resolves `{ value, done }` with `value` as a `Uint8Array`,
 * which is what a `TextDecoder` expects.
 */
function withReader(res) {
  res.getReader = () => {
    const iterator = res[Symbol.asyncIterator]();
    return {
      async read() {
        const { value, done } = await iterator.next();
        if (done) return { value: undefined, done: true };
        return { value: value instanceof Uint8Array ? value : Buffer.from(value), done: false };
      },
      releaseLock() {},
      // Async because the WHATWG one is, and callers chain `.catch()` onto it —
      // the MCP reader does, in its `finally`. `destroy()` returns the stream,
      // so handing that back turns a tidy-up into a TypeError inside a cleanup
      // path, which is the worst place to put one.
      async cancel() {
        res.destroy();
      },
    };
  };
  return res;
}

function request(url, init, records) {
  const client = url.protocol === 'https:' ? https : http;

  const options = {
    method: init.method || 'GET',
    headers: init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers,
    signal: init.signal,
    /**
     * No connection pooling.
     *
     * Node's global agent keeps sockets alive, and a caller that gives up on a
     * response without draining it — `if (!res.ok) throw`, which both callers do
     * — leaves one held open with the event loop still awake. A short script
     * simply never exits; a long-lived server accumulates them.
     *
     * There is a second reason, and it is the one that matters here: a pooled
     * socket outlives the check that approved it. This module's whole promise is
     * that a connection goes to an address that was verified for *this* request,
     * and reusing a socket from an earlier one quietly reintroduces exactly the
     * gap the pinning above closes.
     */
    agent: false,
  };

  /**
   * Pin the socket to a verified address.
   *
   * `records` is null when there was nothing to resolve — a literal IP, already
   * checked — or when ALLOW_PRIVATE_FETCH is on, in which case pinning would be
   * fighting the setting.
   */
  if (records?.length) {
    const [{ address, family }] = records;
    options.lookup = (hostname, opts, cb) => {
      if (opts?.all) return cb(null, [{ address, family }]);
      return cb(null, address, family);
    };
  }

  return new Promise((resolve, reject) => {
    const req = client.request(url, options, (res) => {
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: {
          get: (name) => {
            const value = res.headers[String(name).toLowerCase()];
            return value == null ? null : String(Array.isArray(value) ? value.join(', ') : value);
          },
        },
        body: withReader(res),
        async text() {
          let out = '';
          res.setEncoding('utf8');
          for await (const chunk of res) out += chunk;
          return out;
        },
        async json() {
          let out = '';
          res.setEncoding('utf8');
          for await (const chunk of res) out += chunk;
          return JSON.parse(out);
        },
      });
    });
    req.on('error', reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

/**
 * `fetch`, with every hop checked — and connected to the address that was
 * checked, rather than to whatever a second lookup says a moment later.
 *
 * Redirects are followed by hand rather than by the runtime, which is the only
 * way to inspect each destination before connecting to it.
 */
export async function safeFetch(input, init = {}) {
  let url = input instanceof URL ? input : new URL(String(input));

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const records = await assertPublic(url);

    const res = await request(url, init, records);

    /**
     * `redirect: 'manual'` means the caller wants the 3xx, not the destination.
     *
     * The MCP transport asks for this deliberately: its headers may carry a
     * token, and it would rather refuse a redirect than reason about where the
     * next hop points. Following the hop *is* safe here — every one is checked
     * and cross-origin credentials are stripped below — but "safe" is not the
     * same as "what the caller asked for", and quietly following a redirect for
     * something that said not to is how a deliberate refusal turns into a
     * surprise.
     */
    if (init.redirect === 'manual') return res;

    if (![301, 302, 303, 307, 308].includes(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) return res;
    const next = new URL(location, url);

    // Credentials must not survive a cross-origin hop, and a body must not be
    // replayed to somewhere the caller never named: a 307/308 would resend it
    // verbatim, so that redirect comes back to the caller unfollowed instead.
    if (next.origin !== url.origin) {
      if (init.body != null && (res.status === 307 || res.status === 308)) return res;
      if (init.headers) init = { ...init, headers: stripAuth(init.headers) };
    }
    // Nothing reads a redirect's body, and leaving it unread holds the socket.
    res.body.resume();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method === 'POST')) {
      init = { ...init, method: 'GET', body: undefined };
    }
    url = next;
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
}

/**
 * Every header that looks like a credential, not only the three standard ones.
 *
 * `http_request` lets the model set any header, and APIs put keys in
 * `X-API-Key`, `X-Auth-Token`, `Api-Key` and the like; those used to follow a
 * redirect to whatever origin it named.
 */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie)$|api[-_]?key|token|secret|session|signature|^x-auth/i;

function stripAuth(headers) {
  const out = { ...(headers instanceof Headers ? Object.fromEntries(headers) : headers) };
  for (const key of Object.keys(out)) {
    if (CREDENTIAL_HEADER.test(key)) delete out[key];
  }
  return out;
}

/**
 * Read at most `cap` bytes of a response, then let the connection go.
 *
 * `text()` buffers whatever arrives until the timeout, and a URL a page steered
 * the model to can stream without end — one such read takes the instance, and
 * every other account's turn on it, down with it.
 *
 * Bytes, joined at the end: decoding per chunk splits a UTF-8 character across
 * two chunks, which is how Vietnamese text acquires replacement characters.
 */
export async function readCapped(res, cap) {
  if (!res.body) return { buffer: Buffer.from(await res.text(), 'utf8'), truncated: false };

  const chunks = [];
  let read = 0;
  let truncated = false;
  try {
    for await (const chunk of res.body) {
      if (read + chunk.length > cap) {
        chunks.push(chunk.subarray(0, cap - read));
        truncated = true;
        break;
      }
      chunks.push(chunk);
      read += chunk.length;
    }
  } finally {
    // Let go of the connection rather than leaving it draining in the
    // background after we have stopped caring about it.
    res.body.destroy?.();
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

export const __testing = { isPrivateAddress, assertPublic, stripAuth };
