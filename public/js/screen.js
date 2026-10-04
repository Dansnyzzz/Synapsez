import { api } from './api.js';
import { t } from './i18n.js';
import { toast } from './render.js';

/**
 * The live mirror of whatever the assistant is working in — the browser
 * sandbox, or a real application on the machine.
 *
 * Frames arrive over an event stream and are painted as they land, so the rate
 * is set by how fast the screen actually changes rather than by a poll timer.
 * Polling is kept as a fallback: on a serverless deployment a held-open
 * connection per viewer is exactly what you cannot have, and the frame may have
 * been captured by a different instance entirely.
 *
 * Either way, watching is what tells the worker to keep capturing. Close the
 * panel or hide the tab and the machine stops being read.
 */
const POLL_ACTIVE_MS = 500;
const POLL_IDLE_MS = 2500;
const STALE_MS = 4000;

export function createScreen() {
  const panel = document.getElementById('screen');
  const img = /** @type {HTMLImageElement} */ (document.getElementById('screen-img'));
  const title = document.getElementById('screen-title');
  const url = document.getElementById('screen-url');
  const live = document.getElementById('screen-live');
  const source = document.getElementById('screen-source');
  const closeButton = /** @type {HTMLButtonElement} */ (document.getElementById('screen-stop'));
  const nav = document.getElementById('screen-nav');
  const tabStrip = document.getElementById('screen-tabs');

  /**
   * The tab strip.
   *
   * The sandbox has always had real tabs — the assistant opens pages beside
   * each other rather than on top of what you were reading — but the panel only
   * ever showed the focused one, so a second page looked like the first one
   * disappearing. Pressing a tab moves the assistant's focus too: its next look
   * reads whichever tab is in front.
   *
   * Rebuilt only when the tabs actually change, because this runs on every
   * frame and replacing the row under the pointer would make it unclickable.
   */
  let tabSignature = '';
  function renderTabs(list) {
    const signature = list.map((t) => `${t.index}:${t.host}:${t.active}`).join('|');
    if (signature === tabSignature) return;
    tabSignature = signature;

    tabStrip.hidden = list.length < 2;
    tabStrip.innerHTML = '';
    if (list.length < 2) return;

    for (const tab of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `screen__tab${tab.active ? ' is-active' : ''}`;
      button.textContent = tab.host || t('screen.newTab');
      button.title = t('screen.tabTitle', { n: tab.index, host: tab.host || '' });
      button.addEventListener('click', () => send({ type: 'tab', key: String(tab.index) }));
      tabStrip.append(button);
    }
  }

  let stream = null;
  let timer = null;
  let objectUrl = null;
  let stopped = true;
  let lastFrameAt = 0;
  let fpsWindow = [];

  /**
   * Which browser the panel is showing: the one on the person's own PC
   * ('local', frames relayed by this server) or the one on the account's cloud
   * computer ('cloud').
   *
   * The cloud one streams straight from the machine into the <img> as MJPEG —
   * the browser decodes it natively, and not one frame passes through the app's
   * server, which is what lets a thousand people watch at once. Setting `src`
   * opens the connection and removing it closes it, and the machine only
   * captures while a connection is open.
   */
  let mode = 'local';
  let lastShot = '';

  const hostOf = (address) => {
    try {
      return new URL(address).host;
    } catch {
      return '';
    }
  };

  function showCloud(state) {
    title.textContent = state?.title || (state?.open ? t('screen.title') : t('screen.cloudStarting'));
    url.textContent = state?.url || '';
    source.textContent = t('screen.sourceCloud');
    source.title = t('screen.cloudNote');
    closeButton.hidden = false;
    nav.hidden = false;
    renderTabs((state?.tabs || []).map((tab) => ({ index: tab.index, host: hostOf(tab.url), active: tab.active })));
    panel.hidden = false;
    if (state?.open && state.stream && !stopped) {
      if (img.dataset.stream !== state.stream) {
        img.dataset.stream = state.stream;
        img.src = state.stream;
      }
      live.classList.add('is-live');
    } else {
      live.classList.remove('is-live');
    }
  }

  async function refreshCloud() {
    if (mode !== 'cloud' || stopped) return;
    try {
      showCloud(await api.cloudBrowserState());
    } catch {
      /* the next step refreshes it */
    }
  }

  // The machine paused or restarted under a new key: the stream is gone, so
  // show the last picture rather than a broken image.
  img.addEventListener('error', () => {
    if (mode === 'cloud' && img.dataset.stream) {
      dropCloudStream();
      live.classList.remove('is-live');
      return;
    }
    // Anything else that will not load is taken away, so the frame shows its
    // "no picture yet" line instead of a broken-image icon and its alt text.
    img.removeAttribute('src');
  });

  /** Let go of the live stream, leaving the last step's picture in its place. */
  function dropCloudStream() {
    if (!img.dataset.stream) return;
    delete img.dataset.stream;
    if (lastShot) img.src = lastShot;
    else img.removeAttribute('src');
  }

  function paint({ frame, meta }) {
    if (!frame) return false;

    const bytes = Uint8Array.from(atob(frame), (c) => c.charCodeAt(0));
    const next = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    const previous = objectUrl;
    objectUrl = next;
    img.src = next;
    // Release the old blob only once the new one is on screen, or the image
    // blanks for a frame.
    if (previous) setTimeout(() => URL.revokeObjectURL(previous), 200);

    title.textContent = meta?.title || t('screen.title');
    url.textContent = meta?.url || '';

    // Which thing you are actually looking at. The sandbox is the assistant's
    // own browser window; the desktop mirror is the whole machine. They are not
    // interchangeable and confusing them is how "close it" goes wrong.
    const desktop = meta?.source === 'desktop';
    source.textContent = desktop ? t('screen.sourceDesktop') : t('screen.sourceSandbox');
    source.title = desktop
      ? t('screen.wholeMachine')
      : t('screen.sandboxNote');
    // Only the sandbox is ours to close.
    closeButton.hidden = desktop;
    nav.hidden = desktop;
    renderTabs(desktop ? [] : meta?.tabs || []);

    panel.hidden = false;

    lastFrameAt = Date.now();
    live.classList.add('is-live');

    // A rolling count over the last second, shown so it is obvious whether the
    // mirror is keeping up or the machine is busy.
    fpsWindow.push(lastFrameAt);
    fpsWindow = fpsWindow.filter((t) => lastFrameAt - t < 1000);
    live.dataset.fps = String(fpsWindow.length);
    return true;
  }

  // The stream is the only thing marking us as watching, so if it drops the
  // worker would keep capturing for a viewer who has gone. Reconnect, and fall
  // back to polling if the stream will not hold at all.
  function openStream() {
    if (stream || typeof EventSource === 'undefined') return false;

    // The size being asked for travels with the connection. A rail 340px wide
    // and a full screen on a 2K monitor are not the same request, and sending
    // the larger one all the time is bandwidth nobody is looking at.
    stream = new EventSource(`/api/screen/live${expanded() ? '?hd=1' : ''}`, { withCredentials: true });
    stream.onmessage = (event) => {
      if (stopped) return;
      try {
        paint(JSON.parse(event.data));
      } catch {
        /* a malformed frame is not worth tearing the stream down for */
      }
    };
    stream.onerror = () => {
      closeStream();
      if (!stopped) {
        // EventSource retries on its own for transient faults; getting here
        // usually means the endpoint is unavailable, so poll instead.
        timer = setTimeout(pollTick, POLL_ACTIVE_MS);
      }
    };
    return true;
  }

  function closeStream() {
    if (stream) stream.close();
    stream = null;
  }

  async function pollTick() {
    if (stopped) return;
    let changed = false;
    try {
      changed = paint(await api.screen(expanded()));
    } catch {
      // A missed frame is not worth reporting; the next poll catches up.
    }
    // Re-checked after the await, not only before it. `stop()` can have run
    // while the request was in flight, and re-arming here after `clearTimeout`
    // had already fired left a poll chain nothing owned — a later `start()` then
    // began a second one, both writing the same `timer`, so `stop()` could only
    // ever cancel one of them and the poll rate silently doubled.
    if (stopped) return;
    const fresh = Date.now() - lastFrameAt < STALE_MS;
    timer = setTimeout(pollTick, changed || fresh ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }

  // Nothing has arrived for a while: say so rather than leaving a stale frame
  // looking live.
  // Only while something is actually streaming. This ran once a second for the
  // life of the page whether or not the panel had ever been opened — and
  // `unref` is a Node idiom: a browser `setInterval` returns a number, so the
  // call that looked like it was disarming this did nothing at all.
  setInterval(() => {
    if (stopped || mode === 'cloud') return;
    if (Date.now() - lastFrameAt > STALE_MS) {
      live.classList.remove('is-live');
      live.dataset.fps = '0';
    }
  }, 1000);

  document.getElementById('screen-hide').addEventListener('click', () => {
    panel.classList.toggle('is-collapsed');
  });

  // Closing the sandbox without having to ask the assistant and wait a turn.
  closeButton.addEventListener('click', async () => {
    closeButton.disabled = true;
    try {
      const { message } = mode === 'cloud' ? await api.closeCloudBrowser() : await api.closeScreen();
      toast(message || t('screen.sandboxClosed'));
      if (mode === 'cloud') dropCloudStream();
      panel.hidden = true;
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      closeButton.disabled = false;
    }
  });

  /**
   * Take the controls.
   *
   * Watching something go wrong and being unable to touch it is worse than not
   * watching at all, so the mirror is not a photograph. Coordinates are sent as
   * fractions of the frame, which means a phone showing a scaled-down image
   * still lands where you tapped.
   *
   * Off by default: a stray click while reading would otherwise land in a page
   * the assistant is midway through using.
   */
  let driving = false;
  const drive = document.getElementById('screen-drive');

  const setDriving = (on) => {
    driving = on;
    drive.setAttribute('aria-pressed', String(on));
    drive.classList.toggle('is-active', on);
    panel.classList.toggle('is-driving', on);
    // Both, or the screen reader keeps announcing the state it was in before:
    // name-from-content does not apply once an aria-label exists, so a stale one
    // is what gets read out.
    const label = on ? t('screen.driveOn') : t('screen.driveOff');
    drive.title = label;
    drive.setAttribute('aria-label', label);
    if (on) img.focus();
  };
  drive.addEventListener('click', () => setDriving(!driving));

  const send = async (event) => {
    try {
      if (mode === 'cloud') {
        // The answer says where the page is now, so the header keeps up
        // without the panel polling for it.
        const now = await api.cloudBrowserInput(event);
        showCloud({ open: true, stream: img.dataset.stream, ...now });
      } else {
        await api.screenInput(event);
      }
    } catch (err) {
      toast(err.message, 'error');
      setDriving(false);
    }
  };

  /**
   * Back, forward, reload.
   *
   * Deliberately not behind "take control": moving the page is not the same as
   * clicking inside it, and watching an assistant take a wrong turn with no way
   * to press Back is a strange kind of helplessness. The assistant looks again
   * on its next step and sees wherever the page now is.
   */
  for (const [id, type] of [
    ['screen-back', 'back'],
    ['screen-forward', 'forward'],
    ['screen-reload', 'reload'],
  ]) {
    document.getElementById(id).addEventListener('click', () => send({ type }));
  }

  /** Where in the frame, as a fraction — the panel never needs the real size. */
  const spot = (event) => {
    const box = img.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };

  /**
   * Click and drag, told apart by how far the pointer moved.
   *
   * Pointer events rather than `click`, because a click fires only after the
   * button comes back up in roughly the same place — so panning a chart, which
   * is the same press with a long journey in between, produced either nothing
   * or a click somewhere the user never meant to press. Below the threshold it
   * is a click; above it, the whole gesture goes as one drag and the worker
   * draws the path.
   *
   * The threshold is a fraction of the frame, not pixels, so it means the same
   * thing on a phone showing the mirror at a third of its real size.
   */
  const DRAG_THRESHOLD = 0.008;
  let press = null;

  img.addEventListener('pointerdown', (event) => {
    if (!driving || event.button !== 0) return;
    event.preventDefault();
    // Capture, so a drag that leaves the image still ends properly — releasing
    // outside it used to leave the gesture hanging and the next press was read
    // as its continuation.
    img.setPointerCapture?.(event.pointerId);
    press = { ...spot(event), id: event.pointerId, moved: false };
    img.focus();
  });

  img.addEventListener('pointermove', (event) => {
    if (!press || event.pointerId !== press.id) return;
    const at = spot(event);
    if (!press.moved && Math.hypot(at.x - press.x, at.y - press.y) > DRAG_THRESHOLD) {
      press.moved = true;
      panel.classList.add('is-dragging');
    }
  });

  const endPress = (event) => {
    if (!press || event.pointerId !== press.id) return;
    const at = spot(event);
    const from = press;
    press = null;
    panel.classList.remove('is-dragging');
    img.releasePointerCapture?.(event.pointerId);

    // Judged on the whole journey rather than on `moved`: a pointer that wanders
    // out and comes back to where it started is a click, whatever it did between.
    if (Math.hypot(at.x - from.x, at.y - from.y) > DRAG_THRESHOLD) {
      send({ type: 'drag', x: from.x, y: from.y, toX: at.x, toY: at.y });
    } else {
      send({ type: 'click', x: from.x, y: from.y });
    }
  };

  img.addEventListener('pointerup', endPress);
  // The pointer was taken away mid-gesture — a system gesture, a lost device.
  // Abandon it rather than leaving the panel stuck in its dragging state.
  img.addEventListener('pointercancel', () => {
    press = null;
    panel.classList.remove('is-dragging');
  });

  // Belt and braces against the native image drag. The CSS stops it in every
  // browser that honours `-webkit-user-drag`; this stops it in the ones that
  // only honour the event.
  img.addEventListener('dragstart', (event) => event.preventDefault());

  img.addEventListener(
    'wheel',
    (event) => {
      if (!driving) return;
      event.preventDefault();
      send({ type: 'scroll', ...spot(event), deltaY: event.deltaY });
    },
    { passive: false },
  );

  img.addEventListener('keydown', (event) => {
    if (!driving) return;

    /**
     * Two keys are the user's, not the remote machine's.
     *
     * Tab was being swallowed and forwarded, which made this a keyboard trap:
     * once focus was on the picture there was no key that moved it off, and the
     * only way out was a mouse click on the drive button. That is a WCAG 2.1.2
     * failure and, more plainly, it means somebody driving by keyboard could get
     * stuck inside a remote desktop with no way back to their own page.
     *
     * Escape now turns driving off rather than being sent on. It was already
     * being swallowed here and then reaching the document listener, where it
     * only left full-screen — so pressing it looked like it did nothing while
     * the keyboard stayed captured.
     *
     * Losing Tab and Escape on the remote side is a real cost and the right
     * trade: `desktop_key` sends either deliberately when a task needs it, and
     * neither is worth trapping a person inside a panel for.
     */
    if (event.key === 'Tab') return; // let the browser move focus out
    if (event.key === 'Escape') {
      event.preventDefault();
      setDriving(false);
      drive.focus(); // land somewhere sensible rather than on <body>
      return;
    }

    // Printable characters go as text so accents and IME output survive; named
    // keys go as key presses so Enter and Backspace still mean something.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      send({ type: 'text', text: event.key });
    } else if (['Enter', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      send({ type: 'key', key: event.key });
    }
  });

  /* ── full screen ──────────────────────────────────────────────── */

  const expanded = () => panel.classList.contains('is-expanded');

  /**
   * Where the panel lives when it is not full screen.
   *
   * A marker rather than a remembered index: the rail's contents can change
   * underneath, and putting the panel back "where it was" has to mean the same
   * place, not the same position in a list that has moved on.
   */
  const home = document.createComment('screen panel');

  /**
   * Going full screen moves the panel to the top of the document.
   *
   * `position: fixed` escapes overflow but not a stacking context, and the panel
   * lives inside the detail rail — which has one. So "full screen" was drawn
   * *underneath* the sidebar and the composer, and vanished entirely when the
   * rail was closed, because a closed rail hides its contents. Moved to the body
   * it is a sibling of everything else and simply covers the page.
   *
   * The stream is reopened on the way in and out because the size being asked
   * for is part of the connection: full screen wants the real pixels, the rail
   * does not.
   */
  function setExpanded(on) {
    if (on === expanded()) return;

    if (on) {
      panel.replaceWith(home);
      document.body.append(panel);
      panel.classList.add('is-expanded');
    } else {
      panel.classList.remove('is-expanded');
      home.replaceWith(panel);
    }

    // The cloud stream is one size either way; only the local one is reopened.
    if (!stopped && mode !== 'cloud') {
      closeStream();
      clearTimeout(timer);
      if (!openStream()) pollTick();
    }
  }

  document.getElementById('screen-expand').addEventListener('click', () => {
    panel.classList.remove('is-collapsed');
    setExpanded(!expanded());
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && expanded()) setExpanded(false);
  });

  /**
   * Whether the panel has been opened at all this session.
   *
   * Without this, switching back to the tab called `start()` unconditionally —
   * opening a frame stream, and telling the worker somebody was watching, for a
   * panel that had never been shown. Capturing somebody's screen because they
   * changed tabs is not a small thing to do by accident.
   */
  let everStarted = false;
  /** Whether the panel is open because a tool opened it, rather than a person. */
  let wokenByTool = false;

  // Streaming to a hidden tab is pure waste — and it would keep telling the
  // worker that somebody is watching when nobody is.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (everStarted) start();
  });

  function start() {
    everStarted = true;
    if (!stopped) return;
    stopped = false;
    if (mode === 'cloud') refreshCloud();
    else if (!openStream()) pollTick();
  }

  function stop() {
    stopped = true;
    closeStream();
    clearTimeout(timer);
    dropCloudStream();
    live.classList.remove('is-live');
  }

  /** Switch between the two browsers, closing whatever the other one had open. */
  function setMode(next) {
    if (next === mode) return;
    const wasRunning = !stopped;
    stop();
    mode = next;
    if (next !== 'cloud') lastShot = '';
    if (wasRunning) start();
  }

  return {
    start,
    stop,
    /**
     * Called when a screen tool runs, so the panel appears without waiting.
     *
     * @param {'local' | 'cloud'} [kind]  which browser the tool drives
     */
    wake(kind = 'local') {
      setMode(kind);
      panel.hidden = false;
      panel.classList.remove('is-collapsed');
      wokenByTool = true;
      start();
      // Already running: a new step may have started the machine or moved the page.
      if (kind === 'cloud' && !img.dataset.stream) {
        showCloud({ open: false });
        refreshCloud();
      }
    },
    /**
     * A cloud step finished: pick up where the page is now, and keep its
     * picture for when the live stream rests.
     *
     * @param {string} [shotId]
     */
    cloudStepDone(shotId) {
      if (shotId) lastShot = `/api/attachments/${shotId}`;
      refreshCloud();
    },
    /**
     * The run has finished; stop capturing unless a person is still using it.
     *
     * Nothing used to stop this. `wake()` was called the moment the assistant
     * touched the browser or the desktop, and the stream then stayed open for as
     * long as the tab was foregrounded — so the worker kept capturing and
     * shipping frames of the user's screen long after the work was over. That is
     * bandwidth, and on the desktop tools it is a privacy surprise.
     *
     * Only a panel this opened by itself is closed by itself: one the user
     * opened, or is driving, is theirs. The last frame stays on screen — the
     * panel is not hidden, only the capture ends.
     */
    restIfIdle() {
      if (driving || !wokenByTool) return;
      wokenByTool = false;
      stop();
    },
  };
}
