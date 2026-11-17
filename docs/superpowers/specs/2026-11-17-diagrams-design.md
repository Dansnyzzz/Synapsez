# Diagrams that come out right (1.33.0) — design

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

### Layer 1 — a structured diagram: Synapsez lays it out

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

### Layer 3 — a built-in drawing and image skill

There is a new built-in skill, `builtin:drawing` ("Drawing diagrams and making pictures"). Its description is about the
situation: when asked to draw, sketch, diagram, map a flow or an architecture, chart something, or make a picture or
an illustration. It is read only when that applies. Its instructions are short (at most about 70 lines):
- **Which tool:**
  - numbers go to `chart`;
  - boxes and arrows go to `show_widget` with `diagram`;
  - an illustration or anything free-form goes to `show_widget` with `svg`;
  - a photo-like or artistic picture goes to `generate_image`;
  - a document to keep goes to `create_file`.
- **For a `diagram`:**
  - one idea per box, a title of at most about 5 words, at most 4 short lines;
  - 3–12 boxes is the sweet spot, and anything larger is split into two drawings;
  - groups only for real layers;
  - labels on edges only when they add something;
  - every word in the person's language.
- **For hand-written SVG:**
  - a `viewBox`, `xmlns`, and `system-ui`;
  - text at 12 px or more, with `<tspan>` for line breaks;
  - arrows end on box edges, through one `<marker>`;
  - labels beside lines, never on top of them;
  - contrast at least 4.5:1;
  - no external resources.
- **For `generate_image`:**
  - name the subject, the style, the composition and the light;
  - say the aspect ratio for where it will be used;
  - avoid text inside the picture (models misspell it), and add any words in the reply instead;
  - write the prompt in English when the model in use draws better from English, but describe it back to the person
    in their language.

The `show_widget` description gains one sentence pointing at `diagram` and at this skill, so the menu stays cheap.

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
- **`server/skills/builtin.js`:** `builtin:drawing`.
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
- **Skill:** it is on the menu with the right description, its instructions name the four tools, and a features pin
  checks it.
- **UI:** the conversation shows only the final drawing for a redraw, never the flawed one.

## Release

1.33.0. The changelog (vi and en) says: boxes-and-arrows drawings are now laid out by Synapsez, so their arrows always
connect; a hand-drawn diagram is checked and, if it has mistakes, quietly redrawn once before it is shown; and models
get a drawing and image guide.
