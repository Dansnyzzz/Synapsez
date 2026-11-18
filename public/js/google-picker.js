import { api } from './api.js';
import { t } from './i18n.js';

/**
 * Google Drive through Google's own Picker (owner, 2026-11-18).
 *
 * Drive is asked for as `drive.file`, the scope Google reviews for free: it
 * reaches only the files a person picks in Google's chooser, or that Ephapse
 * itself made. So the + menu's "Add from Google Drive" opens that chooser —
 * Google's page, in Google's frame — and each file picked there is fetched by
 * the server and attached exactly as the old Drive search attached one
 * (`POST /api/connectors/google/drive/:id/attach`, marked as from Drive).
 *
 * The token the Picker needs is minted per opening by the server, can do
 * nothing but `drive.file`, and lives about an hour
 * (`GET /api/connectors/google/picker`). It is asked for before anything is
 * loaded from Google: a deployment without the Picker set up, or an account
 * without Drive, never contacts Google from this page at all.
 */

// Google's loader. The page policy lets this one third-party script in, and frames from docs.google.com.
const LOADER = 'https://apis.google.com/js/api.js';
// How long Google's loader, and then its picker library, may take before the person is told.
const LOAD_TIMEOUT_MS = 20_000;

/** @type {Promise<void> | null} */
let loading = null;
/** One Picker at a time: a second press while the first is opening does nothing. */
let opening = false;

/** Google's loader, then its picker library — each once per page. A failure may be tried again. */
function loadPicker() {
  const w = /** @type {any} */ (window);
  if (w.google?.picker) return Promise.resolve();
  loading ||= new Promise((resolve, reject) => {
    const failed = () => reject(new Error(t('plus.driveLoadFailed')));
    const library = () => w.gapi.load('picker', { callback: resolve, onerror: failed, timeout: LOAD_TIMEOUT_MS, ontimeout: failed });
    if (w.gapi?.load) return library();
    const script = document.createElement('script');
    // A loader that never answers — a stalled network, a blocker that holds it — is a failure too.
    const stalled = setTimeout(() => {
      script.onload = script.onerror = null;
      script.remove();
      failed();
    }, LOAD_TIMEOUT_MS);
    script.src = LOADER;
    script.async = true;
    script.onload = () => {
      clearTimeout(stalled);
      library();
    };
    script.onerror = () => {
      clearTimeout(stalled);
      script.remove();
      failed();
    };
    document.head.append(script);
  }).catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/**
 * Open the Picker; each file picked is attached, and the attachments handed to
 * `onPicked` — `onAttaching` first, since a big file takes a moment.
 * Cancelling does nothing. Anything that goes wrong, the Picker failing in
 * its own frame included, is a sentence for `onError`, in the reader's language.
 *
 * @param {{
 *   language: string,
 *   maxItems?: number,
 *   onAttaching?: () => void,
 *   onPicked: (attachments: any[]) => void,
 *   onError: (message: string) => void,
 * }} options
 */
export async function openDrivePicker({ language, maxItems, onAttaching, onPicked, onError }) {
  if (opening) return;
  opening = true;
  // Where the keyboard goes back to when Google's frame closes.
  const returnTo = /** @type {HTMLElement | null} */ (document.activeElement);
  try {
    let access;
    try {
      access = await api.drivePicker();
    } catch (err) {
      // The server's sentence names environment variables, which is for the owner, not for whoever pressed this.
      onError(err.code === 'picker_not_set_up' ? t('plus.driveNotSetUp') : err.message);
      return;
    }
    await loadPicker();
    const { picker } = /** @type {any} */ (window).google;
    const view = new picker.DocsView(picker.ViewId.DOCS).setMode(picker.DocsViewMode.LIST).setSelectFolderEnabled(false);
    let builder = new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(access.token)
      .setDeveloperKey(access.apiKey)
      .setAppId(access.appId)
      .setLocale(language === 'vi' ? 'vi' : 'en')
      .setOrigin(location.origin);
    if (maxItems > 0) builder = builder.setMaxItems(maxItems);
    const shown = builder
      .setCallback((data) => {
        const action = data?.[picker.Response.ACTION];
        // Google's own failure (a refused key, a site the key does not allow) closes it as a cancel does.
        const failed = action === (picker.Action.ERROR || 'error');
        if (action !== picker.Action.PICKED && action !== picker.Action.CANCEL && !failed) return;
        // Its frame goes with it, rather than one hidden frame of Google's left behind per opening.
        try {
          shown.dispose();
        } catch {
          // Already gone: nothing to tidy.
        }
        returnTo?.focus?.({ preventScroll: true });
        if (failed) {
          // For the owner, in DevTools: what Google said, never the token (docs/google.md, section 7).
          const said = Object.fromEntries(Object.entries(data || {}).filter(([name]) => !/token|key/i.test(name)));
          console.warn('Google Drive picker failed', said);
          onError(t('plus.drivePickerFailed'));
          return;
        }
        const docs = action === picker.Action.PICKED ? data[picker.Response.DOCUMENTS] || [] : [];
        if (!docs.length) return;
        onAttaching?.();
        attachPicked(docs, picker, { onPicked, onError }).catch((err) => onError(err?.message || String(err)));
      })
      .build();
    shown.setVisible(true);
  } catch (err) {
    onError(err.message);
  } finally {
    opening = false;
  }
}

/**
 * Each picked file, one after another: the server fetches it from Drive (a Doc
 * as its .docx twin) and keeps it as this account's attachment. One that fails
 * says why and the rest still come.
 */
async function attachPicked(docs, picker, { onPicked, onError }) {
  const attachments = [];
  for (const doc of docs) {
    const id = String(doc?.[picker.Document.ID] || '');
    if (!id) continue;
    try {
      const { attachment } = await api.attachDriveFile(id);
      attachments.push(attachment);
    } catch (err) {
      onError(err.message);
    }
  }
  if (attachments.length) onPicked(attachments);
}
