# Third-party notices for the built-in skills

The skills in `builtin.js` and `craft.js` are written for this app. Three of them
draw on other people's work, under the licences below. Nothing else in those two
files was copied: the other skills, and the parts of these three not listed here,
are original text.

Material that has no licence was read for ideas only and none of its wording is
reproduced. That covers Anthropic's Claude Design material and the `claude-*`,
`dataviz` and `artifact-type` skills in the `jimliu/baoyu-design` repository, and
the `document-skills` in `ComposioHQ/awesome-claude-skills`. A one-off comparison
before the skills were added found no run of twelve words shared with the first.

## design-direction (Design direction)

- Source: `frontend-design` skill, by Anthropic, PBC, as distributed in
  `jimliu/baoyu-design` at `archive/baoyu-design/built-in-skills/frontend-design.md`.
- Licence: Apache License 2.0. Text: <https://www.apache.org/licenses/LICENSE-2.0>,
  and `LICENSE-frontend-design.txt` beside the source file.
- Changed by us: yes. Only the idea of settling a purpose, a tone and one memorable
  thing before writing any markup is kept. Everything else was rewritten for this
  app: offering 2-4 directions with `ask_options`, numeric design rules, the list of
  looks that read as machine-made, states, and the limits of an html artifact (no
  network, system fonts only). This is a modified work and not Anthropic's text.

## palettes (Palettes and font pairings)

- Source: `theme-factory` skill in `ComposioHQ/awesome-claude-skills`.
- Licence: Apache License 2.0, as stated in that skill's own `LICENSE.txt`
  (text: <https://www.apache.org/licenses/LICENSE-2.0>). The licence text names no
  copyright holder.
- Changed by us: yes. Kept: the shape of the idea (a theme is a palette and a font
  pairing chosen together, offered to the person, then applied consistently, with a
  custom theme made when none fits). Replaced: the ten named themes and their
  files, which were not used. The palettes here are this app's own, from
  `server/office/theme.js`, the contrast figures were computed for them, and the font
  pairings are system-font stacks because an html artifact cannot load web fonts.

## design-qa, writing, landing-page

- Sources: `design-qa`, `content-humanizer`, `copywriting`, `copy-editing`,
  `landing-page-generator` and `ui-design-system` in `alirezarezvani/claude-skills`.
- Licence: MIT. Copyright (c) 2025 Alireza Rezvani. Licence text:

  > Permission is hereby granted, free of charge, to any person obtaining a copy of
  > this software and associated documentation files (the "Software"), to deal in the
  > Software without restriction, including without limitation the rights to use, copy,
  > modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
  > and to permit persons to whom the Software is furnished to do so, subject to the
  > following conditions: The above copyright notice and this permission notice shall be
  > included in all copies or substantial portions of the Software. THE SOFTWARE IS
  > PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
  > NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE
  > AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
  > FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  > OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
  > OTHER DEALINGS IN THE SOFTWARE.

- Changed by us: yes, heavily. The scoring and generator scripts are not used, since
  this app has no local scripts: design QA became a manual checklist done with
  `look_at` and the browser tools; the writing skills dropped the scorer and the
  advice to add personal anecdotes (a model has none, so inventing them is a
  fault), and gained a Vietnamese list; the landing page output is one HTML file,
  not Next.js and Tailwind, with a check that a form without a backend is not a
  working form.

## Added 2026-11-05

- **Automating a job** (`craft.js`): ideas from `engineering/skills/agent-workflow-designer`, `engineering/workflow-builder` and `loop-library` in alirezarezvani/claude-skills (MIT, Copyright (c) 2025 Alireza Rezvani). Rewritten in our own words for this app's tools; every script step removed.
- **Poster or artwork** (`craft.js`): adapted from `canvas-design` in ComposioHQ/awesome-claude-skills (Apache-2.0, its own LICENSE.txt). Changed: shortened and rewritten, the file-output steps and bundled fonts removed, and pointed at this app's tools.
- **Ten more looks** in *Palettes and font pairings* (`craft.js`): colour values from `theme-factory/themes` in ComposioHQ/awesome-claude-skills (Apache-2.0, its own LICENSE.txt). Changed: colours set out as a table, descriptions shortened, font names removed. Their colour values are unchanged.

Licence texts: Apache-2.0 at https://www.apache.org/licenses/LICENSE-2.0 ; the MIT text is at https://github.com/alirezarezvani/claude-skills/blob/main/LICENSE .
