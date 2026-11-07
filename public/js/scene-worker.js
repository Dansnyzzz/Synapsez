import { mount, setHidden, setStillOnly, stats } from './scenes/engine.js';

/**
 * The scenes behind the app, away from the page (owner, 2026-11-06). Painting one
 * takes a moment and drawing it goes on for as long as it is up; here neither can
 * hold up a press, the words of a reply arriving, or anything else a person is
 * looking at. The page only ever says what should be showing. See scenes.js.
 */

/** @type {Map<number, any>} what is mounted, by the page's own number for it */
const mounts = new Map();

/** @param {MessageEvent} event */
self.onmessage = ({ data }) => {
  switch (data.type) {
    case 'mount':
      mounts.set(
        data.key,
        mount(data.canvas, data.id, {
          animate: data.animate,
          onReady: () => self.postMessage({ type: 'ready', key: data.key }),
        }),
      );
      break;
    case 'play':
      mounts.get(data.key)?.play();
      break;
    case 'pause':
      mounts.get(data.key)?.pause();
      break;
    case 'destroy':
      mounts.get(data.key)?.destroy();
      mounts.delete(data.key);
      break;
    case 'hidden':
      setHidden(data.value);
      break;
    case 'stillOnly':
      setStillOnly(data.value);
      break;
    case 'stats':
      self.postMessage({ type: 'stats', asked: data.asked, stats: stats() });
      break;
    default:
  }
};
