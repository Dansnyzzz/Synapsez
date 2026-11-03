/**
 * Arrow keys across a row of choices — a tab list or a radio group (UI-013).
 *
 * The group is one stop in the Tab order: its markup gives the chosen item
 * `tabindex="0"` (or the first, when nothing is chosen) and the rest "-1". The
 * arrows, Home and End move along it and choose as they go, which is what a
 * screen reader user expects of both kinds. The panels here repaint on every
 * choice, replacing the buttons, so focus is put back on the new copy of the
 * one just chosen, found by its first data attribute.
 *
 * @param {HTMLElement} host       listens here, for every group inside it
 * @param {string} selector        what one choice is, e.g. '[role="tab"]'
 */
export function rovingKeys(host, selector) {
  host.addEventListener('keydown', (event) => {
    const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest?.(selector));
    if (!item?.parentElement) return;
    const group = /** @type {HTMLElement[]} */ ([...item.parentElement.querySelectorAll(`:scope > ${selector}`)]);
    const at = group.indexOf(item);
    const step = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: group.length - 1 }[event.key];
    if (step == null) return;
    event.preventDefault();
    const to = group[(step + group.length) % group.length];
    const mark = [...to.attributes].find((a) => a.name.startsWith('data-'));
    to.click();
    const again = mark ? /** @type {HTMLElement[]} */ ([...host.querySelectorAll(`[${mark.name}]`)]).find((n) => n.getAttribute(mark.name) === mark.value) : null;
    (again || to).focus();
  });
}
