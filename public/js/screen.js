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
/** How often the panel asks for fresh tokens, and keeps the machine awake, while somebody drives. */
const DRIVE_REFRESH_MS = 4 * 60 * 1000;
/** Long enough for a socket to the machine to open; past it, the relay. */
const LIVE_OPEN_MS = 6000;

export function createScreen() {
  const panel = document.getElementById('screen');
  const img = /** @type {HTMLImageElement} */ (document.getElementById('screen-img'));
  const frame = img.parentElement;
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
      button.addEventListener('click', () => send({ type: 'tab', index: tab.index, key: String(tab.index) }));
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
   * The cloud one talks to the machine directly. Frames come in and a person's
   * gestures go out over one socket (`connectLive`), so neither passes through
   * the app's server — which is what lets a thousand people watch at once, and
   * what makes driving it feel like a browser rather than a slideshow: a scroll
   * tick used to be a request through a serverless function, a database read
   * and a decryption before it reached the page (owner, 2026-10-07). Where the
   * socket cannot be opened, the picture falls back to MJPEG in the <img> and
   * gestures to the server's relay, batched.
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

  /** Title, address and tabs, from the state call or the socket's own notes. */
  function showMeta(meta) {
    if (meta?.title) title.textContent = meta.title;
    if (meta?.url !== undefined) url.textContent = meta.url || '';
    if (Array.isArray(meta?.tabs)) renderTabs(meta.tabs.map((tab) => ({ index: tab.index, host: hostOf(tab.url), active: tab.active })));
  }

  /** The address an MJPEG stream is at, without the token that changes on every refresh. */
  const streamBase = (address) => String(address || '').split('?')[0];

  function showCloud(state) {
    /*
     * Once the socket has said what the page is, it is the page as it is now. A
     * state call answered after that note is an older picture of it, and used to
     * put the old title back until the next page loaded.
     */
    const socketSaid = liveOpen() && link.meta;
    if (!socketSaid) {
      title.textContent = state?.title || (state?.open ? t('screen.title') : t('screen.cloudStarting'));
      url.textContent = state?.url || '';
      showMeta(state);
    }
    source.textContent = t('screen.sourceCloud');
    source.title = t('screen.cloudNote');
    closeButton.hidden = false;
    nav.hidden = false;
    panel.hidden = false;
    if (!state?.open || stopped) {
      live.classList.remove('is-live');
      return;
    }
    if (state.live && !liveFailed && typeof WebSocket !== 'undefined') {
      dropCloudStream();
      connectLive(state.live);
      return;
    }
    // The fallback: MJPEG straight into the <img>. A fresh token on the same
    // stream is not a new stream — reopening it every refresh would blank it.
    if (state.stream && streamBase(img.dataset.stream) !== streamBase(state.stream)) {
      img.dataset.stream = state.stream;
      img.src = state.stream;
    }
    live.classList.add('is-live');
    live.title = t('screen.viaRelay');
  }

  async function refreshCloud() {
    if (mode !== 'cloud' || stopped) return;
    try {
      showCloud(await api.cloudBrowserState(driving));
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

  /** Let go of the MJPEG stream, leaving the last step's picture in its place. */
  function dropCloudStream() {
    if (!img.dataset.stream) return;
    delete img.dataset.stream;
    if (lastShot) img.src = lastShot;
    else img.removeAttribute('src');
  }

  /** A rolling count over the last second, shown so it is obvious whether the mirror is keeping up. */
  function countFrame() {
    lastFrameAt = Date.now();
    live.classList.add('is-live');
    fpsWindow.push(lastFrameAt);
    fpsWindow = fpsWindow.filter((at) => lastFrameAt - at < 1000);
    live.dataset.fps = String(fpsWindow.length);
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
    countFrame();
    return true;
  }

  /* ── the socket to the cloud machine ─────────────────────────────── */

  /** @type {{ ws: WebSocket, url: string, token: string, opened: boolean, frames: number, meta: boolean } | null} */
  let link = null;
  /** The socket could not be had from here (a proxy, a policy): the relay, until the page reloads. */
  let liveFailed = false;
  let liveUrl = null;
  let painting = false;
  /** @type {Blob | null} */
  let waitingFrame = null;
  let reconnectTimer = null;
  /** Sockets that closed in a row without a frame — past a few, the relay. */
  let liveRetries = 0;

  /** The size the picture is drawn at, in device pixels — the size worth sending. */
  function viewSize() {
    const box = img.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const width = Math.round((box.width || frame.clientWidth || 640) * scale);
    return { width, height: box.height ? Math.round(box.height * scale) : Math.round((width * 800) / 1280) };
  }

  const liveOpen = () => !!link && link.opened && link.ws.readyState === WebSocket.OPEN;

  function tell(message) {
    if (liveOpen()) link.ws.send(JSON.stringify(message));
  }

  function connectLive(info) {
    if (link && link.url === info.url && link.ws.readyState <= WebSocket.OPEN) {
      link.token = info.token;
      return;
    }
    closeLive();
    let ws;
    try {
      ws = new WebSocket(info.url);
    } catch {
      useRelay();
      return;
    }
    ws.binaryType = 'blob';
    const mine = { ws, url: info.url, token: info.token, opened: false, frames: 0, meta: false };
    link = mine;
    const giveUp = setTimeout(() => {
      if (!mine.opened) useRelay();
    }, LIVE_OPEN_MS);
    ws.addEventListener('open', () => {
      mine.opened = true;
      clearTimeout(giveUp);
      ws.send(JSON.stringify({ t: 'auth', token: mine.token, ...viewSize(), driving }));
      live.title = t('screen.direct');
    });
    ws.addEventListener('message', (event) => {
      if (link !== mine) return;
      if (typeof event.data === 'string') {
        try {
          const note = JSON.parse(event.data);
          if (note.t === 'meta') {
            mine.meta = true;
            showMeta(note);
          }
        } catch {
          /* a note we cannot read is not worth the socket */
        }
        return;
      }
      mine.frames += 1;
      paintLive(event.data);
    });
    ws.addEventListener('close', () => {
      clearTimeout(giveUp);
      if (link !== mine) return;
      link = null;
      live.classList.remove('is-live');
      /*
       * Never opened at all — a proxy or a policy in the way — and this browser
       * cannot have the socket: the relay, for good. Anything else (the machine
       * restarted under a new key, the network blinked, too many tabs) is worth
       * asking again with fresh tokens, a few times, before settling for the
       * slow path; one bad moment used to leave the panel on it until a reload.
       */
      if (!mine.opened) {
        useRelay();
        return;
      }
      if (mine.frames) liveRetries = 0;
      if (stopped || mode !== 'cloud') return;
      liveRetries += 1;
      if (liveRetries > 3) {
        useRelay();
        return;
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(refreshCloud, 800 * liveRetries);
    });
  }

  function closeLive() {
    const old = link;
    link = null;
    clearTimeout(reconnectTimer);
    waitingFrame = null;
    if (old && old.ws.readyState <= WebSocket.OPEN) old.ws.close(1000, 'done');
  }

  function useRelay() {
    if (liveFailed) return;
    liveFailed = true;
    closeLive();
    refreshCloud();
  }

  /**
   * Paint a frame, then say so — the machine sends the next only when it has
   * room, so a slow connection skips frames rather than falling behind. A frame
   * that arrives while one is still decoding replaces any other waiting; the
   * skipped one is acknowledged at once.
   */
  function paintLive(blob) {
    if (painting) {
      if (waitingFrame) tell({ t: 'ack' });
      waitingFrame = blob;
      return;
    }
    painting = true;
    const next = URL.createObjectURL(blob);
    const previous = liveUrl;
    liveUrl = next;
    img.src = next;
    const settled = () => {
      if (previous) URL.revokeObjectURL(previous);
      painting = false;
      tell({ t: 'ack' });
      // A frame that finished decoding after the panel stopped must not light it up again.
      if (stopped) return;
      countFrame();
      if (waitingFrame && !stopped) {
        const queued = waitingFrame;
        waitingFrame = null;
        paintLive(queued);
      }
    };
    (img.decode ? img.decode() : Promise.resolve()).then(settled, settled);
  }

  // The panel changed size — the rail, full screen, a rotated phone: frames to fit.
  let sizeTimer = null;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => tell({ t: 'view', ...viewSize() }), 250);
    }).observe(frame);
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

  document.getElementById('screen-hide').addEventListener('click', () => {
    panel.classList.toggle('is-collapsed');
  });

  // Closing the sandbox without having to ask the assistant and wait a turn.
  closeButton.addEventListener('click', async () => {
    closeButton.disabled = true;
    try {
      const { message } = mode === 'cloud' ? await api.closeCloudBrowser() : await api.closeScreen();
      toast(message || t('screen.sandboxClosed'));
      if (mode === 'cloud') {
        closeLive();
        dropCloudStream();
      }
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
  let driveTimer = null;
  const drive = document.getElementById('screen-drive');

  /**
   * Where typing goes while you drive the cloud browser: a text box out of
   * sight over the picture. Key presses on the picture itself could not carry
   * what an input method composes — Vietnamese typed with Telex, or anything
   * pasted — and a text box receives both as the browser does for any field.
   */
  const keys = document.createElement('textarea');
  keys.className = 'screen__keys';
  keys.setAttribute('aria-label', t('screen.keys'));
  keys.setAttribute('autocomplete', 'off');
  keys.setAttribute('autocapitalize', 'off');
  keys.setAttribute('spellcheck', 'false');
  keys.tabIndex = -1;
  frame.append(keys);

  const direct = () => mode === 'cloud';

  const setDriving = (on) => {
    driving = on;
    drive.setAttribute('aria-pressed', String(on));
    drive.classList.toggle('is-active', on);
    panel.classList.toggle('is-driving', on);
    panel.classList.toggle('is-direct', on && direct());
    // Both, or the screen reader keeps announcing the state it was in before:
    // name-from-content does not apply once an aria-label exists, so a stale one
    // is what gets read out.
    const label = on ? t('screen.driveOn') : t('screen.driveOff');
    drive.title = label;
    drive.setAttribute('aria-label', label);
    clearInterval(driveTimer);
    if (direct()) {
      // Sharper and faster frames while somebody drives; the machine kept awake.
      tell({ t: 'view', ...viewSize(), driving: on });
      if (on) {
        driveTimer = setInterval(() => !document.hidden && refreshCloud(), DRIVE_REFRESH_MS);
        refreshCloud();
      }
    }
    if (on) (direct() ? keys : img).focus({ preventScroll: true });
  };
  drive.addEventListener('click', () => setDriving(!driving));

  /* Gestures through the server, for when the socket cannot be had: batched,
     a run of moves or wheel ticks folded into one, in order. */
  let relayQueue = [];
  let relayBusy = false;
  async function flushRelay() {
    if (relayBusy || !relayQueue.length) return;
    relayBusy = true;
    const events = relayQueue.splice(0, 60);
    try {
      showMeta(await api.cloudBrowserInput({ events }));
    } catch (err) {
      relayQueue = [];
      toast(err.message, 'error');
      setDriving(false);
    } finally {
      relayBusy = false;
      if (relayQueue.length) flushRelay();
    }
  }
  function queueRelay(event) {
    const last = relayQueue[relayQueue.length - 1];
    if (event.type === 'move' && last?.type === 'move') relayQueue[relayQueue.length - 1] = event;
    else if (event.type === 'wheel' && last?.type === 'wheel') {
      last.deltaX += event.deltaX;
      last.deltaY += event.deltaY;
    } else relayQueue.push(event);
    flushRelay();
  }

  const send = async (event) => {
    if (mode === 'cloud') {
      if (liveOpen()) tell({ t: 'input', e: event });
      // Through the server, a hover is a request apiece for as long as the
      // pointer moves; only a move with a button held (a drag) is worth one.
      else if (event.type !== 'move' || press) queueRelay(event);
      return;
    }
    try {
      await api.screenInput(event);
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
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    };
  };
  /** Page pixels per screen pixel, for turning a finger's travel into a scroll. */
  const pageScale = () => 1280 / (img.getBoundingClientRect().width || 1280);

  const BUTTON = ['left', 'middle', 'right'];
  /** Which click of a double or triple this press is: near the last one, soon after it. */
  let lastDown = { at: 0, x: 0, y: 0, count: 0 };

  /**
   * Click and drag, told apart by how far the pointer moved — for the desktop
   * mirror, whose worker takes a click or a whole drag as one gesture.
   *
   * The cloud browser takes the real thing instead: press, every move, release,
   * as they happen, so selecting text, dragging a slider or hovering a menu
   * open works the way it does in any browser. A finger is a scroll there, the
   * way it is on a phone; a tap without travel is a click.
   *
   * The threshold is a fraction of the frame, not pixels, so it means the same
   * thing on a phone showing the mirror at a third of its real size.
   */
  const DRAG_THRESHOLD = 0.008;
  let press = null;
  let moveQueued = null;

  img.addEventListener('pointerdown', (event) => {
    if (!driving) return;
    if (!direct() && event.button !== 0) return;
    event.preventDefault();
    // Capture, so a drag that leaves the image still ends properly — releasing
    // outside it used to leave the gesture hanging and the next press was read
    // as its continuation.
    img.setPointerCapture?.(event.pointerId);
    const at = spot(event);
    press = { ...at, id: event.pointerId, moved: false, touch: event.pointerType === 'touch', lastX: event.clientX, lastY: event.clientY, button: BUTTON[event.button] || 'left' };
    if (direct()) {
      // Not for a finger: focusing the box opens the on-screen keyboard, and a
      // scroll is not a reason to. A tap focuses it on release (endPress).
      if (event.pointerType !== 'touch') keys.focus({ preventScroll: true });
      const now = performance.now();
      const near = Math.hypot(at.x - lastDown.x, at.y - lastDown.y) < 0.01;
      const count = now - lastDown.at < 450 && near ? Math.min(3, lastDown.count + 1) : 1;
      lastDown = { at: now, ...at, count };
      press.count = count;
      if (!press.touch) send({ type: 'down', ...at, button: press.button, count });
    } else {
      img.focus();
    }
  });

  img.addEventListener('pointermove', (event) => {
    if (!driving) return;
    if (press && event.pointerId === press.id) {
      const at = spot(event);
      if (!press.moved && Math.hypot(at.x - press.x, at.y - press.y) > DRAG_THRESHOLD) {
        press.moved = true;
        panel.classList.add('is-dragging');
      }
      if (direct() && press.touch && press.moved) {
        // A finger drags the page under it, the way it does on a phone.
        const scale = pageScale();
        send({ type: 'wheel', ...at, deltaX: Math.round((press.lastX - event.clientX) * scale), deltaY: Math.round((press.lastY - event.clientY) * scale) });
        press.lastX = event.clientX;
        press.lastY = event.clientY;
        return;
      }
    }
    // Every move, at most once a frame: what hovers, opens.
    if (!direct() || (press?.touch && press.id === event.pointerId)) return;
    const first = !moveQueued;
    moveQueued = spot(event);
    if (first) {
      requestAnimationFrame(() => {
        const at = moveQueued;
        moveQueued = null;
        if (at && driving) send({ type: 'move', ...at });
      });
    }
  });

  const endPress = (event) => {
    if (!press || event.pointerId !== press.id) return;
    const at = spot(event);
    const from = press;
    press = null;
    panel.classList.remove('is-dragging');
    img.releasePointerCapture?.(event.pointerId);

    if (direct()) {
      if (from.touch) {
        // A tap that went nowhere is a click — and may be into a field, so the
        // keyboard can come up; a drag already scrolled.
        if (!from.moved) {
          send({ type: 'click', ...from, button: 'left', count: from.count });
          keys.focus({ preventScroll: true });
        }
      } else {
        send({ type: 'up', ...at, button: from.button, count: from.count });
      }
      return;
    }
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
  // Abandon it rather than leaving the panel stuck in its dragging state, and
  // let go of the button on the page too.
  img.addEventListener('pointercancel', (event) => {
    if (press && direct() && !press.touch) send({ type: 'up', ...spot(event), button: press.button, count: press.count });
    press = null;
    panel.classList.remove('is-dragging');
  });
  // The page's own menu, not the panel's, while you are driving it.
  img.addEventListener('contextmenu', (event) => {
    if (driving && direct()) event.preventDefault();
  });

  // Belt and braces against the native image drag. The CSS stops it in every
  // browser that honours `-webkit-user-drag`; this stops it in the ones that
  // only honour the event.
  img.addEventListener('dragstart', (event) => event.preventDefault());

  /**
   * The wheel, both ways.
   *
   * Only `deltaY` was ever sent, so a page that scrolls sideways — a wide
   * table, a timetable — could not be moved across at all (owner, 2026-10-07).
   * Shift turns a plain wheel sideways, as browsers do. Ticks are folded into
   * one per frame: a touchpad sends dozens a second.
   */
  let wheelQueued = null;
  img.addEventListener(
    'wheel',
    (event) => {
      if (!driving) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      let deltaX = event.deltaX * unit;
      let deltaY = event.deltaY * unit;
      if (event.shiftKey && !deltaX) [deltaX, deltaY] = [deltaY, 0];
      const first = !wheelQueued;
      wheelQueued = wheelQueued
        ? { ...spot(event), deltaX: wheelQueued.deltaX + deltaX, deltaY: wheelQueued.deltaY + deltaY }
        : { ...spot(event), deltaX, deltaY };
      if (!first) return;
      requestAnimationFrame(() => {
        const tick = wheelQueued;
        wheelQueued = null;
        if (!tick) return;
        const event2 = { type: mode === 'cloud' ? 'wheel' : 'scroll', x: tick.x, y: tick.y, deltaX: Math.round(tick.deltaX), deltaY: Math.round(tick.deltaY) };
        send(event2);
      });
    },
    { passive: false },
  );

  /** Keys that mean something on their own, sent as presses rather than text. */
  const NAMED = new Set([
    'Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Insert',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ]);

  /**
   * A key event as the chord the page should feel: modifiers, then the key.
   * The page runs in Chrome on Linux, where shortcuts are Control's: on a Mac,
   * Command+A has to arrive as Control+A or it selects nothing.
   */
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  function chordOf(event) {
    const control = event.ctrlKey || (MAC && event.metaKey);
    const mods = [control && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', !MAC && event.metaKey && 'Meta'].filter(Boolean);
    let key = event.key === ' ' ? 'Space' : event.key;
    if (key.length === 1 && (event.ctrlKey || event.metaKey || event.altKey)) {
      // Shortcuts by the key's place, so Control+A is select all on any layout.
      const code = /^Key([A-Z])$/.exec(event.code || '')?.[1] || /^Digit(\d)$/.exec(event.code || '')?.[1];
      key = code ? code.toLowerCase() : key;
    }
    return [...mods, key].join('+');
  }

  /**
   * Keys, in the cloud browser: named keys and shortcuts as presses; letters,
   * accents and pastes as text from the box (`input`, below).
   *
   * Tab and Escape stay the person's, as on the picture: Tab moves focus on
   * (WCAG 2.1.2 — no keyboard trap) and Escape gives the controls back.
   */
  keys.addEventListener('keydown', (event) => {
    if (!driving) return;
    if (event.key === 'Tab') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDriving(false);
      drive.focus();
      return;
    }
    if (event.isComposing || event.key === 'Process' || event.key === 'Unidentified' || event.key === 'Dead') return;
    const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey;
    // Paste is the person's own clipboard: let it happen here, and the text goes as text.
    if (shortcut && (event.key === 'v' || event.key === 'V')) return;
    if (NAMED.has(event.key) || (shortcut && event.key.length === 1)) {
      event.preventDefault();
      send({ type: 'key', key: chordOf(event) });
    }
  });

  let composing = false;
  /** Whatever the box holds — typed, composed or pasted — goes to the page as text, and the box is emptied. */
  const flushTyped = () => {
    const text = keys.value;
    keys.value = '';
    if (text && driving) send({ type: 'text', text: text.slice(0, 5000) });
  };
  keys.addEventListener('compositionstart', () => {
    composing = true;
  });
  keys.addEventListener('compositionend', () => {
    composing = false;
    flushTyped();
  });
  keys.addEventListener('input', (event) => {
    if (composing || /** @type {InputEvent} */ (event).isComposing) return;
    flushTyped();
  });
  keys.addEventListener('blur', () => {
    keys.value = '';
  });

  img.addEventListener('keydown', (event) => {
    if (!driving || direct()) return;

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
   * The local stream is reopened on the way in and out because the size being
   * asked for is part of the connection. The cloud socket stays open and is
   * told the new size instead (the resize observer above).
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

    if (!stopped && mode !== 'cloud') {
      closeStream();
      clearTimeout(timer);
      if (!openStream()) pollTick();
    }
    if (driving && direct()) keys.focus({ preventScroll: true });
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
    closeLive();
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
    panel.classList.toggle('is-direct', driving && direct());
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
      if (kind === 'cloud' && !img.dataset.stream && !liveOpen()) {
        showCloud({ open: false });
        refreshCloud();
      }
    },
    /**
     * A cloud step finished: pick up where the page is now, and keep its
     * picture for when the live screen rests.
     *
     * @param {string} [shotId]
     */
    cloudStepDone(shotId) {
      if (shotId) lastShot = `/api/attachments/${shotId}`;
      // With the socket open the screen and its address are already current.
      if (!liveOpen()) refreshCloud();
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
