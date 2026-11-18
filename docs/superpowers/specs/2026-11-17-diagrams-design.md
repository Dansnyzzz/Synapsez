# Diagrams that come out right (1.34.0) — design

Asked by the owner on 2026-11-17, with a screenshot of a pipeline diagram whose arrows pointed at nothing and cut through text:
"đảm bảo AI vẽ xong cũng tự gửi xem lại audit check 1 lần cho ra bản hoàn thiện perfect final, đẹp, bố cục rõ ràng 100%
chứ còn bị lỗi mũi tên này mà gửi (bạn có thể làm tạo thêm skill vẽ, tạo ảnh cho AI models để nhanh, gọn, lẹ, chính xác)".
All three layers were approved, in the order: 1.32.0, then diagrams, then R2. The owner said "continue full".

## Today (facts)

- `show_widget` (`server/tools/definitions.js:1385`, handler `server/tools/cloud.js:1266`) takes `svg` or `html`. The
  model writes every coordinate by hand, and it cannot see the result.
- `checkDiagram` (`server/widgetCheck.js`) reads the markup and estimates text widths. It catches labels that run off
  the drawing or out of their box, low contrast, text drawn over other text, tiny text, and the wrong script. **It does
  not look at arrows or lines at all**, which is what went wrong in the owner's screenshot.
- When the check finds problems, the flawed drawing **is still shown**, and the model is asked to draw it again, so the
  person sees both the bad one and the redraw. Only a clean drawing is kept as a file.
- Built-in skills live in `server/skills/builtin.js` (docx, xlsx, pptx, pdf, artifact, skill-creator). They are read
  only when their description matches the situation. There is none for drawing or for making images.
- `chart` already draws anything numeric to scale from data. `generate_image` makes pictures.

## Design

### Layer 1 — a structured diagram: Ephapse lays it out

`show_widget` gains a third input, `diagram`, for flows, architectures, pipelines, processes and org charts. The model
says what is in the drawing, and the server draws it. Arrows start and end on box edges by construction, and they never
cross a box or a label.

```jsonc
{
  "direction": "right",            // "right" (default) or "down"
  "nodes": [
    { "id": "app", "title": "Tầng 1 — Ứng dụng", "lines": ["RAPTOR: cây tóm tắt", "MemGPT, Mem0"], "group": "client", "kind": "box" }
  ],
  "groups": [ { "id": "client", "title": "Phía người dùng" } ],
  "edges":  [ { "from": "app", "to": "gw", "label": "prompt đã nén", "style": "solid" } ]
}
```

- **Limits.** These are refused with a message naming what to change:
  - up to 40 nodes and 80 edges;
  - an `id` matches `[A-Za-z0-9_-]{1,40}` and is unique;
  - a `title` is at most 60 characters;
  - `lines` holds at most 6 lines of at most 80 characters each;
  - up to 8 groups, which do not nest;
  - an edge naming an unknown node is refused with that id in the message.
- **Kinds.** `box` (default), `pill` (start/end), `note` (lighter, for an aside). `style` is `solid` (default) or
  `dashed`.
- **Layout.** It is deterministic: the same input always gives the same SVG.
  1. **Ranks.** Break cycles: a depth-first search marks back edges, which are reversed for layout and drawn as they
     were given. Then rank by the longest path from the sources.
  2. **Long edges.** An edge that spans more than one rank gets a dummy node in each rank it passes, so it is routed
     through a free slot and never through a box.
  3. **Order within a rank.** Barycentre sweeps (4 passes, down then up) reduce crossings. Nodes of one group are kept
     next to each other, the group placed at its members' mean position.
  4. **Size.** Boxes are sized to their text. The title is 14 px bold and the lines 12.5 px, at the same width
     estimates `widgetCheck` uses. Lines wrap at a maximum box width of 260 px, padding is 12 px, and the minimum width
     is 120 px.
  5. **Spacing.** The gap between ranks is 72 px (direction right) or 56 px (down). The gap between nodes in a rank is
     24 px, and 40 px between groups.
  6. **Edges.** Each edge is routed at right angles. It leaves its source from the side facing its target and enters
     its target from the facing side. Several edges on one side get evenly spaced ports. The vertical (or horizontal)
     part runs in the gap between ranks, and each edge in a gap gets its own lane so two lines never overlap.
  7. **Edge labels.** A label sits on the longest straight part of its edge, on a small backing in the canvas colour,
     and is moved along the edge until it touches no box.
  8. **Groups.** A group is a rounded, lightly tinted container with its title, around its members, with a 16 px
     margin.
  9. **Fit.** The `viewBox` is fitted to the content plus a 24 px margin. Wider than 1,200 px, it scales down through
     the `viewBox`, so the text stays crisp.
- **Look.**
  - A light canvas: the existing `canvas: 'light'` path, as in the owner's screenshot.
  - One accent colour per group from a small fixed palette.
  - Dark ink with at least 4.5:1 contrast.
  - Arrowheads from a single `<marker>`.
  - `font-family: system-ui, sans-serif`.
- **The check still runs.** The drawn SVG goes through `checkDiagram` and the new line check (layer 2) like any other.
  A problem found in a drawing the server laid out is a bug in the layout: it is logged, and the drawing is still shown.
- **What the model is told.** `diagram` is the default for anything with boxes and arrows. Hand-written `svg` is for
  illustrations and anything the structure cannot say. `chart` stays the tool for numbers.

### Layer 2 — lines and arrows are checked, and a flawed drawing is redrawn once, unseen

**New checks in `checkDiagram`**, for drawings written by hand. They cover `<line>`, `<polyline>`, and `<path>` with
`M/L/H/V/Z` commands, absolute or relative. A curve is checked only at its ends. Arrows are found two ways:
`marker-end`/`marker-start`, or a small filled triangle `<polygon>`/`<path>` whose tip touches the line's end. Positions
inside a transformed group are skipped, as today.
- **Points at nothing.** An arrow end that is not within 14 px of a box's edge, a text's box, or another line's end:
  "an arrow at (x, y) points at nothing: end it on the edge of the box it belongs to."
- **Crosses text.** A line segment that crosses a text box other than its own label (a label within 18 px of the
  segment's midpoint counts as its own): "the arrow from … to … runs through '<text>'".
- **Goes through a box.** A segment that crosses the inside of a box that is not at either of its ends: "the arrow from
  … runs through the box '<title>'".
- **Boxes overlap.** Two boxes overlap by more than 6 px without one fully containing the other.

Each finding is worded for the model, as today, with at most the existing `MAX_ISSUES`.

**One audit, one final, as the owner asked.**
- When a hand-drawn `svg` has problems on its **first** attempt in a conversation for a given title:
  - it is **not shown** and not kept;
  - the result tells the model what is wrong and to draw it again, suggesting `diagram` when it has boxes and arrows;
  - the person sees the step "Đang kiểm tra hình vẽ…" ("Checking the drawing…"), not the flawed picture.
- The **second** attempt is shown and kept whatever the check says. If problems remain, the model is told which ones,
  so it can say so. The count is kept in the store for 30 minutes (`store.addToCounter`, key
  `widget:redraw:<chat>:<sha1 of the normalised title>`), so a person never waits on a third try. With no chat (an
  automation or bot run), the first attempt is shown, as today.
- A `diagram` input never takes the hidden path: it is shown at once.

### Layer 3 — a drawing guide with SVG recipes for many kinds of drawing (owner, 2026-11-17)

The owner asked for this to be like the Word document skill, with scripts for designing SVG, "vì sẽ có nhiều loại
chứ không cố định" (because there will be many kinds, not a fixed one). So the structured `diagram` covers flows and
architectures, and **four built-in skills** cover everything else. Each skill gives a recipe for one kind of drawing:
an SVG skeleton to fill in, plus the arithmetic that places each item. That keeps the model from guessing coordinates.

The skills follow the house style of `server/skills/craft.js`:
- the description is about 170 characters and names the situation;
- the instructions are about 4,000 characters, read only when the skill applies;
- every figure is checkable (the contrast ratios are computed, not remembered).

They are split so that a model reads only the family it needs.

**`builtin:drawing`** — "Drawing diagrams and making pictures". Read first, whenever something is to be drawn.
- **Which tool:**
  - `chart` for numbers;
  - `show_widget` with `diagram` for boxes and arrows;
  - `show_widget` with `svg` for every other kind, using a recipe skill;
  - `generate_image` for a photo-like or artistic picture;
  - `create_file` for a document to keep.
- **The design system every recipe uses.** These are constants the model copies:
  - **Canvas:** `viewBox="0 0 W H"` with W 720–1200, a 24 px margin, `xmlns`, `font-family: system-ui, sans-serif`.
  - **Type scale:** title 18 bold, heading 14 bold, body 12.5, caption 11. Nothing below 11.
  - **Spacing grid:** 8 px. Gaps of 16, 24 or 40 px. Line height 1.35.
  - **Palette:** ink #1F2937; muted ink #4B5563 (7.6:1 on white); lines #64748B; one accent per group from six tints,
    each with its stroke colour. All the pairs meet 4.5:1 for text.
  - **Strokes:** 1.5 px for lines, 1 px for box borders, corner radius 8.
  - **Arrows:** one `<marker>` (the definition is given), and every arrow ends on a box edge, never at a centre.
  - **Text that fits:** about `0.55 × font size` per letter (0.6 bold). Wrap with `<tspan x=… dy="1.35em">` before a
    line passes its box.
- **The checklist before sending:**
  - everything is inside the `viewBox`;
  - no text touches a line;
  - arrows connect;
  - every word is in the person's language;
  - the check will be run, and a flawed drawing is redrawn once.
- **Pictures** (`generate_image`):
  - subject, style, composition and light;
  - the aspect ratio for where it is used;
  - no text in the picture;
  - the prompt may be in English, but describe it back in the person's language.

**`builtin:svg-structures`** — trees and wholes. Recipes:
- **Org chart / tree:** levels at fixed y; children spread evenly under their parent; elbow connectors.
- **Mind map:** centre node; branches at angles `360/n`; text kept horizontal.
- **Pyramid / funnel:** n bands, widths stepping by an equal amount.
- **Cycle:** n nodes on a circle of radius R at angles `-90 + 360·i/n`; curved arrows between neighbours, ending on
  the next node's edge.
- **Venn:** two or three circles with 30–40 % overlap; labels outside the overlaps.

**`builtin:svg-sequences`** — things in order. Recipes:
- **Timeline / roadmap:** a horizontal axis; markers at `x_i = M + i·(W−2M)/(n−1)`; labels alternating above and
  below so they never collide.
- **Step-by-step process:** numbered circles joined by a line; each step's text under its number.
- **Swimlane:** lanes as bands with the lane name at the left; boxes in lanes; arrows between lanes enter from the side.
- **Sequence diagram:** participants across the top; lifelines; messages as horizontal arrows top to bottom, each
  labelled above its line.
- **Gantt-style plan:** rows as tasks; bars from start to end on a date scale.

**`builtin:svg-layouts`** — comparisons and figures. Recipes:
- **Comparison cards:** n columns of equal width `(W − 2M − (n−1)·g)/n`; the same rows in each.
- **2×2 matrix / quadrant:** axes with labels; items placed by their two scores.
- **Pros and cons / before and after:** two columns.
- **KPI or stat cards:** a large number, a label and a small trend arrow.
- **Labelled illustration:** a simple shape drawing with call-outs ending on what they name.

Each recipe gives:
- **When to use it**, in one line.
- **The skeleton:** a short SVG with `{placeholders}`.
- **The placement formula.**
- **One pitfall**, for example a timeline's labels colliding when n is greater than 6, so put them on two rows.

The `show_widget` description gains one sentence: use `diagram` for boxes and arrows, otherwise read `builtin:drawing` and
the recipe for the kind of drawing. This keeps the always-paid tool menu cheap.

**The line check (layer 2) knows these shapes.** An arrow may end on a `rect`, a `circle`, an `ellipse`, a closed
`polygon` or `path` (taken by its bounding box), or a text. A cycle or a Venn diagram drawn from a recipe must check
clean, and the tests draw one of each from the recipes to prove it.


### Adaptive and professional (owner, 2026-11-17)

The owner asked for this to be "flexible adaptive smartest beautiful, chuyên nghiệp, high advanced, đẹp, đầy đủ, chi
tiết chuyên sâu nhất, cụ thể hóa". This section makes that concrete.

**The structured diagram adapts.**
- `direction` defaults to `"auto"`. Both directions are laid out, and the one whose box is closer to a 16:10 shape
  wins, provided it fits 1,200 px wide without scaling below 0.8; otherwise the narrower one wins. `"right"` and
  `"down"` still force a direction.
- The drawing follows the conversation's canvas. `theme: "light"` (default) or `"dark"` switches the palette and ink;
  each pair keeps 4.5:1.
- The look:
  - each group gets its own accent: a 6 % tint fill, a 1 px stroke in the accent, and the title in the accent's dark
    shade;
  - a node has a white card with a soft shadow (`feDropShadow` at 6 % opacity, 1 px down, 3 px blur) and an 8 px
    radius;
  - a `pill` is fully rounded, and a `note` has a dashed border and muted text;
  - the title is 14 px semibold and the lines are 12.5 px muted ink;
  - edges are 1.5 px slate with a 7 px arrowhead, and a dashed edge uses a 5/4 dash;
  - edge labels are 11.5 px on a canvas-coloured backing with 4 px padding.
- A node may carry `icon`: one of a small built-in set of line icons (user, server, database, cloud, cache, gear,
  document, chat, lock, chart, search, bolt). Each is drawn as inline paths at 16 px in the group's accent. An unknown
  icon is refused with the list of known ones.

**The skills are full guides, not summaries.**
- **Size.** Each recipe skill may run to about 9,000 characters, and `builtin:drawing` to about 7,000. Only the family
  in use is read, so the size costs nothing on other turns. The description of each stays near 170 characters, because
  it is in every prompt.
- **What every recipe gives:**
  - when to use it, and when to use another kind instead;
  - a **complete, valid SVG skeleton** with `{placeholders}`, which renders correctly when filled;
  - the **placement arithmetic** for n items;
  - an **adaptive rule** for each case:
    - many items (beyond the comfortable count, switch to the variant given, for example a timeline beyond 6 goes to
      two rows, and beyond 12 goes vertical);
    - long text (wrap rule and box growth);
    - narrow screens (the vertical variant for a viewBox narrower than 720);
    - dark canvas (the colour swap);
  - **the polish**: hierarchy, alignment, one accent per meaning, shadows used once, numbering or icons where they help;
  - **the pitfalls**, with how to avoid each.
- **`builtin:svg-flows`** is added for flows that `diagram` does not express: decision branches with yes/no labels,
  loops back, swimlanes and sequence diagrams. So the families are flows, structures, sequences and layouts.
- **Tests fill every skeleton** with sample data at its comfortable size, at its adaptive extreme, and on a dark
  canvas. Every filled skeleton must pass `checkDiagram` (including the line check) with no issues.

## Code shape

- **`server/diagram/layout.js`** (new, pure): `layoutDiagram(input) → { width, height, nodes: [{ id, x, y, w, h,
  lines }], groups: [{ id, x, y, w, h }], edges: [{ id, points: [[x, y], …], label?, labelAt? }] }`.
- **`server/diagram/render.js`** (new, pure): `renderDiagram(layout, input) → svg string`.
- **`server/diagram/validate.js`** (new, pure): `validateDiagram(input) → { ok, error }`, with the limits above.
- **`server/widgetCheck.js`:** `checkLines(markup)` is joined into `checkDiagram`'s issues.
- **`server/tools/cloud.js` `showWidgetTool`:** validate, lay out, render, check and keep a `diagram`; keep the
  redraw-once rule for `svg`.
- **`server/tools/definitions.js`:** the `diagram` schema (JSON Schema with `nodes`, `edges`, `groups`, `direction`)
  and the description sentence.
- **`server/skills/craft.js`** (where the design skills live): `builtin:drawing`, `builtin:svg-flows`, `builtin:svg-structures`, `builtin:svg-sequences` and `builtin:svg-layouts`.
- **`public/js`:** nothing new to draw: the widget is SVG as today. The step label "Đang kiểm tra hình vẽ…" is added in
  both locales if a hidden first attempt needs its own label. Reuse the existing `step.show_widget` mechanics.

## Tests

- **Layout:**
  - determinism: the same input gives the same SVG;
  - no two boxes overlap;
  - every edge starts and ends on its boxes' edges;
  - no edge segment crosses a box that is not at either of its ends;
  - no edge label overlaps a box;
  - a cycle is drawn;
  - a long edge goes through dummies, not boxes;
  - groups contain their members;
  - direction `down` mirrors `right`;
  - 40 nodes and 80 edges still lay out within a time budget (at most 200 ms in the test).
- **The check:**
  - an arrow pointing at nothing, an arrow through text, an arrow through a box and overlapping boxes are each found,
    with the owner's screenshot reconstructed as a fixture;
  - a clean diagram, the owner's correct ones and a layer-1 drawing find nothing.
- **Redraw once:**
  - a flawed first `svg` is not shown and not kept, and the model is told;
  - the second attempt is shown and kept;
  - a `diagram` is never hidden;
  - with no chat, it is shown at once.
- **Skills:**
  - all four are on the menu, with descriptions of about 170 characters and instructions of about 4,000 characters;
  - `builtin:drawing` names the tools and the design constants;
  - each recipe skill holds its recipes;
  - **every recipe's skeleton, filled with sample data, renders and passes `checkDiagram` with no issues** (a test fills
    and checks each one);
  - a features pin checks the skills.
- **UI:** the conversation shows only the final drawing for a redraw, never the flawed one.

## Release

1.34.0. The changelog (vi and en) says: boxes-and-arrows drawings are now laid out by Ephapse, so their arrows always
connect; a hand-drawn diagram is checked and, if it has mistakes, quietly redrawn once before it is shown; and models
get a drawing and image guide.
