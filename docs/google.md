# Connecting Google (Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks, Contacts)

Written for: the person who runs this deployment. Once this is done, every account on it can
connect its own Google account from **Settings → Connectors → Google** with one button.

Everything here is free. Google charges nothing for these APIs at personal-use volumes; each
has a daily quota far above what one person uses. Since 1.33.1 the review is free too: Ephapse
asks Google for no *restricted* scope (owner, 2026-11-18). Gmail can only send (`gmail.send`),
and Drive reaches only the files a person picks in Google's own Picker or that Ephapse creates
(`drive.file`). Restricted scopes are the ones whose review needs a paid yearly security
assessment; sensitive and non-sensitive scopes are reviewed for free.

## 1. Create the OAuth client (once, ~10 minutes)

1. Open <https://console.cloud.google.com/> and create a project (any name, e.g. "Ephapse").
2. **APIs & Services → Library** — enable each of these:
   Gmail API, Google Calendar API, Google Drive API, Google Docs API, Google Sheets API,
   Google Forms API, Google Tasks API, People API, and **Google Picker API** (section 7).
   An API left off only disables that product; the error says which one to enable.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**. App name, support email, developer email.
   - **Data Access**: add the scopes in section 6. The app asks for them at sign-in either way,
     but the verification review (section 8) reads this list.
   - **Audience**: add your own Google address (and anyone else's) under *Test users* while the
     app is in Testing.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorised redirect URI**: `https://YOUR-DOMAIN/api/connectors/google/callback`
     — for example `https://www.ephapse.net/api/connectors/google/callback`. The whole
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
| `GOOGLE_PICKER_API_KEY` | the Picker's browser API key (section 7) |
| `GOOGLE_PROJECT_NUMBER` | the Cloud project's number (section 7) |

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

## 3. Testing, publishing and verification

While the consent screen's publishing status is **Testing**, Google expires the connection
**every 7 days** and only the listed test users can sign in. The assistant then says
"Google access has expired — reconnect", and pressing the button again fixes it.

To stop that, go to **Google Auth Platform → Audience** and press **Publish app**. Until
Google has verified the app, people see a "Google hasn't verified this app" screen (click
*Advanced → Go to …*) and the app is capped at 100 users. Gmail sending, Calendar, Docs,
Sheets, Forms, Tasks and Contacts are *sensitive* scopes, so removing that screen takes
Google's verification review — which for sensitive scopes is free and needs no security
assessment. Section 8 has what to submit.

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

Then choose **I have fixed the issues** on the Branding page. This is separate from the scope
verification in section 8.

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
conversation that read Drive or another Google product: the assistant says so, and another
model (or a new conversation without Google data) works.

## 6. The scopes, and Google Auth Platform → Data Access

| Scope | Google's class | What Ephapse uses it for |
|---|---|---|
| `openid` | non-sensitive | Signing the connection in, so it belongs to one Google account. |
| `https://www.googleapis.com/auth/userinfo.email` | non-sensitive | The connected address, shown in Settings → Connectors. |
| `https://www.googleapis.com/auth/userinfo.profile` | non-sensitive | The name shown beside it. |
| `https://www.googleapis.com/auth/drive.file` | non-sensitive | The files a person picks in the Google Picker ("Add from Google Drive" in the + menu), attached to a message; and the Docs, Sheets, folders and uploads Ephapse creates, which it may then read, move, rename, share or trash when asked. |
| `https://www.googleapis.com/auth/gmail.send` | sensitive | Sending an email the person asked for. Nothing in the mailbox is read. |
| `https://www.googleapis.com/auth/calendar` | sensitive | Listing calendars, events and free/busy times; creating, moving and cancelling events when asked. |
| `https://www.googleapis.com/auth/documents` | sensitive | Reading a Google Doc the person names; writing a new one, adding to one, find and replace. |
| `https://www.googleapis.com/auth/spreadsheets` | sensitive | Reading a sheet's tabs and ranges; writing, appending, creating and clearing when asked. |
| `https://www.googleapis.com/auth/forms.body` | sensitive | Creating a form with its questions, adding questions, reading a form. |
| `https://www.googleapis.com/auth/forms.responses.readonly` | sensitive | Reading the responses a form collected. |
| `https://www.googleapis.com/auth/tasks` | sensitive | Showing task lists and tasks; adding, completing and deleting a task when asked. |
| `https://www.googleapis.com/auth/contacts.readonly` | sensitive | Looking up a person's email address or phone number by name. Read only. |

The classes for `gmail.send` and `drive.file` were checked on Google's own pages on
2026-11-18. The Data Access page sorts each scope into its class as you add it: if any of them
lands under **Restricted**, stop — Ephapse should ask for none.

**Google Auth Platform → Data Access → Add or remove scopes → Manually add scopes**: paste
this list, one scope per line, press **Add to table**, then **Update**, then **Save**:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/forms.body
https://www.googleapis.com/auth/forms.responses.readonly
https://www.googleapis.com/auth/tasks
https://www.googleapis.com/auth/contacts.readonly
```

Remove any other Gmail or Drive scope the list still holds from before 1.33.1.

## 7. The Drive Picker (once, ~5 minutes)

With `drive.file`, Google lets Ephapse open a Drive file only once the person has picked it in
Google's own chooser, the Google Picker. The Picker runs in the page, so it needs a browser
API key and the project number.

1. **APIs & Services → Library → Google Picker API → Enable**, in the same project as the
   OAuth client.
2. **APIs & Services → Credentials → Create credentials → API key**, then edit the key:
   - **Application restrictions: Websites**, with exactly these two:
     `https://www.ephapse.net/*` and `https://docs.google.com/*`. The Picker runs in a frame
     on docs.google.com, and its own requests come from there. For a local run, add
     `http://localhost:5173/*` too (your port if `PORT` is set).
   - **API restrictions: Restrict key → Google Picker API**, and nothing else.
3. The project number: **IAM & Admin → Settings → Project number**. It is the digits, not the
   project ID. It is the Picker's app id: a file picked in the Picker is granted to this project,
   so the server's own connection can then open it.
4. On Vercel, set `GOOGLE_PICKER_API_KEY` to the key and `GOOGLE_PROJECT_NUMBER` to the number,
   then redeploy.

The key is public by design: every page that opens the Picker carries it, and the two
restrictions above are what keep it to this site and this one API. Until both variables are
set, "Add from Google Drive" tells the person it is not set up here and loads nothing from
Google. The page's Content-Security-Policy already lets in `https://apis.google.com` (the
loader script) and `https://docs.google.com` (the Picker's frame), in both
`server/securityHeaders.js` and `vercel.json`. In a real Chrome run against Google's real
loader on 2026-11-18, nothing was blocked by it, on a desktop and on a phone-sized screen.

**The first live test confirms the one thing not yet seen working.** Open a conversation, then
**+ → Connectors → Add from Google Drive**, pick a file, and check that it lands beside the
message box. The server mints the Picker's token by refreshing the stored grant with
`scope=https://www.googleapis.com/auth/drive.file`, and hands it over only if Google says it
holds `drive.file` and nothing wider. Whether Google honours that narrowing on a refresh has not
been confirmed live. If the Picker step says "Reconnect Google" or "Google did not confirm that
the Drive picker's token is limited to the files you pick", Google did not narrow it. No wider
token leaves the server, and its log has a line starting `google picker token refused`.
A Google account connected for Drive before 1.33.1 is expected to see that refusal until it
reconnects (section 9).

## 8. The verification submission (free)

Submit from **Google Auth Platform → Verification Center** once sections 4 and 6 are done and the
app is published. Google asks, for each sensitive scope, how the app uses it, and for a demo
video. The answers below are ready to paste: each says what Ephapse does with the scope, that it
is used only when the person asks, and the Limited Use commitment. `drive.file`, `openid` and
the two `userinfo` scopes are non-sensitive and need none.

The closing sentence of each, also usable on its own wherever the form asks about data use:

> Data received through this scope is used only to do what the user asked, is never used for
> advertising, never sold, never used to build a profile of the user, and never used to develop,
> improve or train AI or machine-learning models. A conversation that holds it is sent only to AI
> providers that do not train on it (the Anthropic or OpenAI APIs, or OpenRouter restricted to
> zero-data-retention endpoints). Ephapse's use and transfer to any other app of information
> received from Google APIs will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

**`gmail.send`**

> Ephapse is an AI assistant. It sends an email from the user's Gmail only when the user asks the
> assistant to send one in a chat (or in a scheduled task the user set up), and by default shows
> the user the recipients, subject and message for approval before sending. Ephapse never reads,
> searches, drafts or changes the mailbox; the only Gmail action it has is sending a new message.
> Data received through this scope is used only to do what the user asked, is never used for
> advertising, never sold, never used to build a profile of the user, and never used to develop,
> improve or train AI or machine-learning models. A conversation that holds it is sent only to AI
> providers that do not train on it (the Anthropic or OpenAI APIs, or OpenRouter restricted to
> zero-data-retention endpoints). Ephapse's use and transfer to any other app of information
> received from Google APIs will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

**`calendar`**

> Ephapse is an AI assistant. When the user asks in a chat (or in a scheduled task the user set
> up), it lists the user's calendars and events, checks free and busy times to find a slot, and
> creates, moves or cancels an event, with invitations, reminders, a Meet link or a repeat rule if
> the user asks for them. By default every change is shown to the user for approval first. Events
> are read only to answer the user's request.
> Data received through this scope is used only to do what the user asked, is never used for
> advertising, never sold, never used to build a profile of the user, and never used to develop,
> improve or train AI or machine-learning models. A conversation that holds it is sent only to AI
> providers that do not train on it (the Anthropic or OpenAI APIs, or OpenRouter restricted to
> zero-data-retention endpoints). Ephapse's use and transfer to any other app of information
> received from Google APIs will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

**`documents`**

> Ephapse is an AI assistant. When the user asks in a chat (or in a scheduled task the user set
> up), it reads a Google Doc the user names so it can summarise or answer questions about it,
> writes a new Doc with headings, lists and tables, adds text to the end of a Doc, or finds and
> replaces text in it. By default every change is shown to the user for approval first.
> Data received through this scope is used only to do what the user asked, is never used for
> advertising, never sold, never used to build a profile of the user, and never used to develop,
> improve or train AI or machine-learning models. A conversation that holds it is sent only to AI
> providers that do not train on it (the Anthropic or OpenAI APIs, or OpenRouter restricted to
> zero-data-retention endpoints). Ephapse's use and transfer to any other app of information
> received from Google APIs will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

**`spreadsheets`**

> Ephapse is an AI assistant. When the user asks in a chat (or in a scheduled task the user set
> up), it lists a spreadsheet's tabs and reads a range as a table so it can analyse the figures,
> writes or appends rows (formulas included), creates a spreadsheet, or clears a range. By default
> every change is shown to the user for approval first.
> Data received through this scope is used only to do what the user asked, is never used for
> advertising, never sold, never used to build a profile of the user, and never used to develop,
> improve or train AI or machine-learning models. A conversation that holds it is sent only to AI
> providers that do not train on it (the Anthropic or OpenAI APIs, or OpenRouter restricted to
> zero-data-retention endpoints). Ephapse's use and transfer to any other app of information
> received from Google APIs will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

**`forms.body`**

> Ephapse is an AI assistant. When the user asks in a chat (or in a scheduled task the user set
> up), it creates a Google Form with the questions the user wants, adds questions to one of the
> user's forms, or reads a form so it can describe or check it. By default every change is shown
> to the user for approval first.
> Data received through this scope is used only to do what the user asked, is never used for
> advertising, never sold, never used to build a profile of the user, and never used to develop,
> improve or train AI or machine-learning models. A conversation that holds it is sent only to AI
> providers that do not train on it (the Anthropic or OpenAI APIs, or OpenRouter restricted to
> zero-data-retention endpoints). Ephapse's use and transfer to any other app of information
> received from Google APIs will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

**`forms.responses.readonly`**

> Ephapse is an AI assistant. When the user asks in a chat (or in a scheduled task the user set
> up), it reads the responses one of the user's forms has collected so it can count, summarise or
> chart them for the user. It never changes or deletes a response.
> Data received through this scope is used only to do what the user asked, is never used for
> advertising, never sold, never used to build a profile of the user, and never used to develop,
> improve or train AI or machine-learning models. A conversation that holds it is sent only to AI
> providers that do not train on it (the Anthropic or OpenAI APIs, or OpenRouter restricted to
> zero-data-retention endpoints). Ephapse's use and transfer to any other app of information
> received from Google APIs will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

**`tasks`**

> Ephapse is an AI assistant. When the user asks in a chat (or in a scheduled task the user set
> up), it shows the user's task lists and what is on them, adds a task with a due date, or marks
> a task complete or deletes it. By default every change is shown to the user for approval first.
> Data received through this scope is used only to do what the user asked, is never used for
> advertising, never sold, never used to build a profile of the user, and never used to develop,
> improve or train AI or machine-learning models. A conversation that holds it is sent only to AI
> providers that do not train on it (the Anthropic or OpenAI APIs, or OpenRouter restricted to
> zero-data-retention endpoints). Ephapse's use and transfer to any other app of information
> received from Google APIs will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

**`contacts.readonly`**

> Ephapse is an AI assistant. When the user asks in a chat (or in a scheduled task the user set
> up), it looks up a person in the user's Google Contacts by name to find their email address or
> phone number, for example to address an email the user asked it to send. It only reads
> contacts; it never creates, changes or deletes one.
> Data received through this scope is used only to do what the user asked, is never used for
> advertising, never sold, never used to build a profile of the user, and never used to develop,
> improve or train AI or machine-learning models. A conversation that holds it is sent only to AI
> providers that do not train on it (the Anthropic or OpenAI APIs, or OpenRouter restricted to
> zero-data-retention endpoints). Ephapse's use and transfer to any other app of information
> received from Google APIs will adhere to the Google API Services User Data Policy, including the
> Limited Use requirements.

**The demo video**, in English, uploaded to YouTube as *unlisted*, in this order:

1. **The consent screen.** Signed in to `https://www.ephapse.net`, open **Settings → Connectors**,
   choose a Google product and press **Connect**. Show Google's consent screen with the app name
   **Ephapse** and the scopes it lists, and keep the address bar in view so the OAuth client ID in
   it can be read. Allow.
2. **Each sensitive scope in use**, one short scene each, in a chat:
   - `gmail.send` — "Send an email to … saying …": the approval card, Approve, then the message in
     Gmail's *Sent* folder.
   - `calendar` — "When am I free tomorrow afternoon? Add a meeting at 3 pm": the answer, the
     approval, then the event in Google Calendar.
   - `documents` — "Write a one-page summary of … as a Google Doc", then open the Doc.
   - `spreadsheets` — "Read the totals in my sheet …", then "add a row …", and show the sheet.
   - `forms.body` and `forms.responses.readonly` — "Make a feedback form with three questions",
     open it; then "summarise the responses of my form …".
   - `tasks` — "Add 'Call the bank' to my tasks for Friday", then show it in Google Tasks.
   - `contacts.readonly` — "What is Lan's email address?", answered from Google Contacts.
3. **The Drive Picker.** In the message box, **+ → Connectors → Add from Google Drive**: Google's
   Picker opens, pick a file, it lands beside the message box; ask a question about it.
4. Optionally, **Settings → Connectors → Disconnect**, to show that access can be withdrawn.

## 9. Connections made before 1.33.1

Before 1.33.1 Ephapse asked for `gmail.modify` and the whole of Drive. A connection made then
keeps working: the server counts those older, wider grants as covering `gmail.send` and
`drive.file` (`server/google.js`), so nobody is disconnected by the release. Two things follow:

- **The older grant stays as wide as it was until the person narrows it.** Ephapse asks Google with
  `include_granted_scopes=true`, so connecting again on top of an old connection keeps the old
  scopes. To narrow it: in **Settings → Connectors**, **Disconnect** every Google product in use
  (when the last one goes, Ephapse revokes the grant at Google), then **Connect** again the ones
  wanted. Gmail is used only to send either way; the Drive tool, though, can still see the whole
  Drive through an old grant.
- **The Drive Picker needs the new grant.** The Picker's token asks Google for exactly
  `drive.file`, which an old Drive grant never literally held, so Google can refuse it and the
  person sees "Reconnect Google". Disconnecting every Google product and connecting again fixes it.

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
| Gmail | `gmail` | — (it cannot read mail) | send a new message |
| Calendar | `google_calendar` | list, calendars, free/busy | create (with Meet, invitations, reminders, recurrence), update, delete |
| Drive | `google_drive` | search, read (Docs, Sheets, Slides, PDF, text) — only files picked in the Picker or created by Ephapse | create Doc/Sheet/folder/file, upload from chat, and share, move, rename or trash those files |
| Docs | `google_docs` | read | create (formatted from HTML), append, find & replace |
| Sheets | `google_sheets` | tabs, read range | write, append, create, clear |
| Forms | `google_forms` | read form, read responses | create with questions, add questions |
| Tasks | `google_tasks` | lists, tasks | add, complete, delete |
| Contacts | `google_contacts` | search, list | — (read-only) |

Only the products a person ticks — and then actually allows on Google's screen — are offered
to the model. Tokens are encrypted at rest and not sent to the browser; the one exception is the
Picker's short-lived token, which can reach nothing but `drive.file` (section 7). In Settings →
Connectors each product is its own connector with its own page: **Connect** signs in for that
product alone (`/api/connectors/google/start?products=drive`), and **Disconnect** turns that
one off (`DELETE /api/connectors/google/:product`) — its tools stop at once, the others stay.
Google grants scopes to the one sign-in, so the grant on Google's side is revoked when the
last product goes. Anything written by someone else (a document, a form answer, a file) is
handed to the model marked as untrusted.

## In the + menu

With Drive allowed, the + beside the message box offers **Add from Google Drive** under
Connectors. It opens the Google Picker straight away — Google's own chooser, in a frame of
docs.google.com — where the person picks one or more files (as many as the message still has
room for). Each picked file is attached to the message like an upload — a Google Doc, Sheet or
Slides as its .docx, .xlsx or .pptx twin, anything else as it is, under the same size and type
rules — and the conversation is marked as holding Google data (section 5). The server fetches
each file (`POST /api/connectors/google/drive/:fileId/attach`). The browser gets only the
Picker's token, minted for each opening and never cached (`GET /api/connectors/google/picker`).
Cancelling the Picker attaches nothing. Google can be **paused** from the same menu without
disconnecting it: its tools are then not offered and the assistant is not told it has it.
