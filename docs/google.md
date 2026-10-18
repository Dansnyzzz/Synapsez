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
