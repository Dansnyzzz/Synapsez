# Domain security: keeping visitors on the real site

How Synapsez protects people from DNS spoofing and look-alike phishing. What the code
already does, what only the owner can do, and how to check it live.

## Check it

- **In the app**: Settings → System → *Address safety* → *Check now* (administrators only).
- **From a terminal**: `npm run domain:check` (uses `PUBLIC_URL` and the mail sender), or
  `npm run domain:check -- https://your.domain you@your.domain`.

Both run the same checks (`server/domainCheck.js`), live, against public resolvers:

| Check | What it proves | Good when |
|---|---|---|
| DNSSEC | DNS answers for the address are signed, so a forged answer is detectable | Cloudflare's and Google's validating resolvers both set the AD flag |
| HTTPS | The site answers over TLS with a valid certificate | `PUBLIC_URL` is `https://` and reachable |
| HSTS | Browsers refuse to use the address without HTTPS | `max-age` ≥ 1 year, `includeSubDomains` |
| Preload | Even a first visit is HTTPS-only | The name, a parent, or its top-level domain is on the HSTS preload list |
| CAA | Only named authorities may issue certificates for the name | A CAA record on the name or a parent |
| Mail | Email in the site's name cannot be faked | SPF, and DMARC at `p=quarantine` or `p=reject` (MTA-STS reported) |

## What the code does (since 1.17.0)

- **HSTS for two years, subdomains included, with `preload`** (`server/securityHeaders.js`,
  mirrored in `vercel.json`). A browser that has seen it never tries the address in the
  clear again; a spoofed DNS answer then needs a valid certificate for the name, which the
  attacker cannot get.
- A strict Content-Security-Policy, `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- Session and known-browser cookies are `HttpOnly`, `SameSite=Lax` and `Secure` over HTTPS.

## What only the owner can do

`synapsez.vercel.app` is a name in **Vercel's** zone. Vercel does not sign `vercel.app` with
DNSSEC and offers no setting to do so, and Vercel's own nameservers do not support DNSSEC
for custom domains either (Vercel community answers, January–April 2026). It is still well
protected: `.app` is on the HSTS preload list as a whole top-level domain, so every browser
uses HTTPS for it from the first visit, and `vercel.app` has CAA records limiting issuance to
Let's Encrypt and Google Trust Services.

For full DNS authentication, move to a domain of your own:

1. Buy a domain at a registrar that supports DNSSEC (most do).
2. Host its DNS at a provider that signs zones — Cloudflare DNS is free and does. Point the
   domain at Vercel there (Vercel's *Domains* page gives the A/CNAME records; keep the
   Cloudflare proxy off, "DNS only", so Vercel issues the certificate).
3. Turn **DNSSEC** on at the DNS host, and add the **DS record** it shows at the registrar.
4. Add **CAA** records: `0 issue "letsencrypt.org"` and `0 issue "pki.goog"` (what Vercel
   uses), and optionally `0 iodef "mailto:you@your.domain"`.
5. Set `PUBLIC_URL` to `https://your.domain` on Vercel and redeploy.
6. After HSTS with `preload` has been served for a few weeks, submit the domain at
   <https://hstspreload.org>. This is slow to undo: every subdomain must serve HTTPS for good.
7. **Email**: to make mail in the site's name impossible to fake, send from the domain
   rather than `@gmail.com` (whose DMARC policy is Google's, `p=none`). Publish SPF, sign
   with DKIM, and set DMARC to `p=quarantine`, then `p=reject` once reports are clean;
   MTA-STS and TLS-RPT are the next step.

Run the check again after each step: every line should read *Good*.
