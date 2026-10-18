# Connecting Google (Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks, Contacts)

Written for: the person who runs this deployment. Once this is done, every account on it can
connect its own Google account from **Settings → Connectors → Google** with one button.

Everything here is free. Google charges nothing for these APIs at personal-use volumes; each
has a daily quota far above what one person uses.

## 1. Create the OAuth client (once, ~10 minutes)

1. Open <https://console.cloud.google.com/> and create a project (any name, e.g. "Synapsez").
2. **APIs & Services → Library** — enable each of these:
   Gmail API, Google Calendar API, Google Drive API, Google Docs API, Google Sheets API,
   Google Forms API, Google Tasks API, People API.
   An API left off only disables that product; the error says which one to enable.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**. App name, support email, developer email.
   - **Data access / Scopes**: you can skip adding scopes here — the app asks for them at sign-in.
   - **Audience**: add your own Google address (and anyone else's) under *Test users*.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorised redirect URI**: `https://YOUR-DOMAIN/api/connectors/google/callback`
     — for example `https://synapsez.vercel.app/api/connectors/google/callback`. The whole
     path, not just the domain: the domain alone is what *Authorised JavaScript origins*
     takes, and putting it here gives `Error 400: redirect_uri_mismatch`.
     For a local run also add `http://localhost:5173/api/connectors/google/callback`
     (5173 is the default port; use yours if `PORT` is set).
   - Copy the **Client ID** and **Client secret**.

## 2. Give them to the deployment

On Vercel: **Project → Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the client ID |
| `GOOGLE_CLIENT_SECRET` | the client secret |
| `PUBLIC_URL` | `https://YOUR-DOMAIN` (recommended, so the redirect address is exact) |
| `GOOGLE_REDIRECT_URI` | optional — only if the callback lives somewhere other than the address above |

### "Error 400: redirect_uri_mismatch"

Google compares the redirect address character for character. The app sends
`GOOGLE_REDIRECT_URI` if it is set, otherwise `<the address you opened the app at>/api/connectors/google/callback`
(or `PUBLIC_URL` + that path when `PUBLIC_URL` is set). Add that exact address under
**Authorised redirect URIs** — a missing path, `http` for `https`, a trailing `/`, `www.`, or a
Vercel preview address (`ai-remote-xxxx.vercel.app`) instead of your main one are each a
mismatch. Setting `PUBLIC_URL` pins it to one address. Changes on Google's side can take a few
minutes to apply.

### "Error 403: access_denied — has not completed the Google verification process"

The consent screen is in **Testing** and the Google account signing in is not one of its test
users. Add that exact address under **Google Auth Platform → Audience → Test users** (up to
100), or publish the app (below). A school or work account (Google Workspace) can also be held
back by its own administrator's third-party-app policy — that shows as `admin_policy_enforced`,
and only that organisation's admin can allow it; a personal Gmail account avoids it.

## 3. The one thing to know about "Testing" mode

While the consent screen's publishing status is **Testing**, Google expires the connection
**every 7 days** and only the listed test users can sign in. The assistant then says
"Google access has expired — reconnect", and pressing the button again fixes it.

To stop that, press **Publish app** on the consent screen. Gmail and Drive are *restricted*
scopes, so an unverified published app shows people a "Google hasn't verified this app"
screen (click *Advanced → Go to …*) and is capped at 100 users — fine for yourself, a family
or a small team. Removing the warning for the public requires Google's verification review,
which for restricted scopes includes a paid security assessment; that is a business decision,
not a code change.

## 4. Branding verification (free, no security assessment)

Google's **Branding** page checks three things before it shows the app's name and logo on the
consent screen. None of them costs anything:

1. **The home page is yours.** Verify `https://YOUR-DOMAIN/` as a *URL-prefix* property in
   [Search Console](https://search.google.com/search-console) with the *HTML file* method: Google
   gives you a file such as `google1234abcd.html`; put it in `public/`, deploy, press **Verify**.
   This deployment's file is `public/google19190bbd34c2487c.html` — leave it in place, or the
   verification lapses. Use the same Google account as the Cloud project.
2. **The privacy policy link** is `https://YOUR-DOMAIN/privacy.html` — not the home page. It
   names who runs the deployment, what is read from each Google product, and carries the Limited
   Use statement Google asks for.
3. **The home page links the policy and says what the app does** — the sign-in screen does both
   without an account.

Then choose **I have fixed the issues** on the Branding page. This is separate from the
restricted-scope review in section 3, which is the one that needs a paid assessment.

## 5. Where Google data may go (Limited Use)

Google's [API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
lets this app pass what it reads from Google to another service only to do what the person asked,
and never so that it trains a general model. `server/googleData.js` keeps that true:

- A conversation **holds Google data** once a Google tool has returned something in it, or a file
  from Drive was attached. It stays so, folded turns included.
- Such a conversation is sent only to **Anthropic**, **OpenAI**, or **OpenRouter asked for
  zero-retention endpoints** (strict privacy, whatever the account chose). A **Gemini key** (the
  free tier may train) and **OrcaRouter** are refused with a sentence saying why. Gemini *through
  OpenRouter* is fine if one of its endpoints there has zero retention.
- The same holds for everything such a turn starts — a fold, a sub-agent, deep research, a picture
  read for a model that cannot see, a cheap model for a role — and the tools that call a Gemini
  key directly (Google-grounded search, `generate_image`, searching indexed folders) stand aside.
- Sub-agents are never given the Google tools: their answer would come back unmarked.
- A memory note saved in such a conversation is marked, and like an excerpt from it found by
  `search_chats`, is read only into conversations that hold Google data too.

On the free tier this means a free model whose only providers keep data cannot answer a
conversation that read Gmail or Drive: the assistant says so, and another model (or a new
conversation without Google data) works.

## Google Search

Separate from the above and needs no OAuth: web search uses real Google results through
Gemini's *grounding with Google Search* whenever a Gemini key exists — `GEMINI_API_KEY` on the
deployment, or the account's own Google key in Settings → Providers. It sits second in the
search chain (after Exa, before DuckDuckGo) and stands aside silently when there is no key.
Google's older Custom Search JSON API no longer accepts new customers, which is why it is not
used.

## What the assistant can then do

| Product | Tool | Reads (run at once) | Writes (always shown to you first) |
|---|---|---|---|
| Gmail | `gmail` | search, read, labels | send, reply, draft, label, trash |
| Calendar | `google_calendar` | list, calendars, free/busy | create (with Meet, invitations, reminders, recurrence), update, delete |
| Drive | `google_drive` | search, read (Docs, Sheets, Slides, PDF, text) | create Doc/Sheet/folder/file, upload from chat, share, move, rename, trash |
| Docs | `google_docs` | read | create (formatted from HTML), append, find & replace |
| Sheets | `google_sheets` | tabs, read range | write, append, create, clear |
| Forms | `google_forms` | read form, read responses | create with questions, add questions |
| Tasks | `google_tasks` | lists, tasks | add, complete, delete |
| Contacts | `google_contacts` | search, list | — (read-only) |

Only the products a person ticks — and then actually allows on Google's screen — are offered
to the model. Tokens are encrypted at rest and never sent to the browser; disconnecting also
revokes the grant on Google's side. Anything written by someone else (an email body, a
document, a form answer) is handed to the model marked as untrusted.

## In the + menu

With Drive allowed, the + beside the message box offers **Add from Google Drive**: a search
of the person's Drive (newest first, or by name), and a file picked there is attached to the
message like an upload — a Google Doc, Sheet or Slides as its .docx, .xlsx or .pptx twin,
anything else as it is, under the same size and type rules. The server fetches it
(`GET /api/connectors/google/drive`, `POST /api/connectors/google/drive/:fileId/attach`); the
browser never sees the token. Google can be **paused** from the same menu without
disconnecting it: its tools are then not offered and the assistant is not told it has it.
