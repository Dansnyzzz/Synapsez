# SKILL_MAP — what is installed, and what this audit will actually use

Written 2026-09-09. This file did not exist before, which is itself a finding
(`CFG-013`): PHẦN II of the audit rules requires every phase to open with
`Skill nạp lượt này: [...]` **theo `audit/SKILL_MAP.md`**, and there was no such
file for that declaration to be checked against.

Source of the list: the skills and MCP servers enumerated in this session's own
tool manifest. Nothing here is guessed; where a capability could not be
confirmed it says `[UNKNOWN]`.

---

## 1. What is installed

### Project skills — `.claude/skills/` (3, all tracked in git)

| Name | Description (read from the file) | Lines |
|---|---|---|
| `accessibility-checklist` | Keyboard, screen readers, contrast, touch targets, i18n for `public/` | 53 |
| `api-conventions` | Auth, error shape, status codes, rate limiting, validation for an HTTP route | 76 |
| `token-budget` | What is paid per step vs per turn when changing anything that enters a prompt | 82 |

### Plugin skills available in this session

`superpowers` (14): using-superpowers, brainstorming, writing-plans, executing-plans,
subagent-driven-development, dispatching-parallel-agents, test-driven-development,
systematic-debugging, requesting-code-review, receiving-code-review,
verification-before-completion, finishing-a-development-branch, using-git-worktrees,
writing-skills.

`gitnexus` (12): gitnexus-cli, gitnexus-guide, gitnexus-exploring, gitnexus-debugging,
gitnexus-impact-analysis, gitnexus-refactoring, gitnexus-review, gitnexus-plan,
gitnexus-work, gitnexus-lfg, gitnexus-taint-analysis, gitnexus-pdg-query.

`claude-mem` (19): mem-search, learn-codebase, smart-explore, make-plan, do, babysit,
design-is, pathfinder, standup, knowledge-agent, timeline-report, weekly-digests,
oh-my-issues, version-bump, mode-creator, cloud-sync, how-it-works, what-the, wowerpoint.

`repomix` (4): pack-local, pack-remote, explore-local, explore-remote.

`context7` (2): docs, context7-mcp.

Built-in Claude Code: code-review, simplify, security-review, run, init,
update-config, fewer-permission-prompts, keybindings-help, loop, schedule,
claude-api, dataviz, design, artifact-design, artifact-capabilities,
artifact-diagramming, developing-with-streamlit.

### MCP servers

| Server | State |
|---|---|
| `gitnexus` | tools available (query, trace, impact, explain, pdg_query, route_map, tool_map, …) |
| `repomix` | available |
| `context7` | available |
| `claude-mem` search | available |
| Google Drive | available |
| **claude.ai Ahrefs** | **NOT AUTHENTICATED.** A non-interactive session cannot run OAuth. Unavailable this audit. |

### Subagents — `.claude/agents/` (9, all tracked)

backend-engineer · frontend-engineer · database-architect · qa-tester ·
security-auditor · performance-optimizer · code-reviewer · technical-writer ·
ui-ux-designer. Seven are `model: opus`, two (`qa-tester`, `technical-writer`)
are `model: sonnet`.

---

## 2. Routing table

| Skill/Plugin | Phase | What it replaces or speeds up | Risk | Quyết định |
|---|---|---|---|---|
| `gitnexus-exploring` / `impact_analysis` / `trace` | 1, 2 | Building the call graph by hand before touching a shared symbol | Index may be stale against the working tree | **DÙNG CÓ ĐIỀU KIỆN** — `detect_changes` first; an answer from a stale index is not a `[FACT]` |
| `gitnexus-taint-analysis` / `pdg_query` | 1 §E | Manual source→sink tracing for injection | Findings are leads, not proof | **DÙNG CÓ ĐIỀU KIỆN** — every hit re-read by hand before it enters the ledger |
| `gitnexus-review` | 3 | Multi-axis review of the branch diff | Reads a diff it did not write — that is the value | **DÙNG** at Phase 3 |
| `gitnexus-work` / `gitnexus-lfg` | — | Executes plans and **commits** on its own gating | Writes code and runs git; collides with the Phase 0/1 no-edit rule and with PHẦN III | **KHÔNG DÙNG** — see `CFG-017` |
| `superpowers:systematic-debugging` | 2 | Structured root-cause work when a fix goes red | None | **DÙNG** when the gate is red |
| `superpowers:test-driven-development` | 2 | Failing-test-first per ID | None | **DÙNG** |
| `superpowers:verification-before-completion` | 2, 3 | Blocks a "done" claim with no command output behind it | None — it restates this audit's §2 | **DÙNG** |
| `superpowers:requesting-code-review` + `.claude/agents/code-reviewer` | 3 | Cold read of the finished diff | Subagents have died to session rate limits twice in this repo's history | **DÙNG**, one at a time, with an explicit "report partial findings" instruction |
| `superpowers:finishing-a-development-branch` | 4 | Deciding how work integrates | **Its remit includes merging** | **DÙNG CÓ ĐIỀU KIỆN** — advice only; no git command from it is executed |
| `superpowers:using-git-worktrees` | 2 | Isolating the work | An extra checkout a solo repo does not need | **KHÔNG DÙNG** |
| `.claude/skills/token-budget` | 1 §D, §H | Per-step vs per-turn cost, already reasoned for this repo | Headline numbers are stale — see `CODE-015` | **DÙNG**, numbers re-measured |
| `.claude/skills/accessibility-checklist` | 1 §G | The WCAG pass over `public/` | None | **DÙNG** |
| `.claude/skills/api-conventions` | 1 §C, 2 | Route shape, auth, error contract | **Says every route lives in `server/app.js` — false since ARCH-004.** See `CODE-013` | **DÙNG CÓ ĐIỀU KIỆN** until corrected |
| `claude-mem:mem-search` | 0 | Recovering prior-session findings not in the ledger | Returns recollections, not evidence | **DÙNG CÓ ĐIỀU KIỆN** — output is a lead, never a `[FACT]` |
| `claude-mem:learn-codebase` | 0 | Reading the tree | Reads every file in full — enormous context for a 76k-line repo already inventoried | **KHÔNG DÙNG** |
| `repomix:pack-local` | 0 | Packing the repo for bulk analysis | Duplicates `audit/INVENTORY.md`, which exists | **KHÔNG DÙNG** |
| `context7:docs` | 1 §3, 2 | Current API signatures before writing against an SDK — CLAUDE.md §3 requires looking up rather than guessing | None | **DÙNG** when touching an SDK |
| `claude-api` | 1 §D, §H | Model ids, pricing, caching, token counting | None | **DÙNG** |
| `code-review` (built-in) / `simplify` | 3 | Diff review | Overlaps `gitnexus-review` and `code-reviewer` — three reviewers is context waste | **DÙNG 1 TRONG 3**: the `code-reviewer` agent by default; `gitnexus-review` when the change is graph-shaped |
| `security-review` (built-in) | 3 | Security pass over the branch | Overlaps `.claude/agents/security-auditor`, which is written for *this* threat model | **KHÔNG DÙNG** — the project agent is strictly better here |
| `design`, `dataviz`, `artifact-*`, `developing-with-streamlit`, `wowerpoint`, `design-is` | — | Nothing in this audit | Pure context weight | **KHÔNG DÙNG** |
| `claude-mem` timeline / digest / version-bump / oh-my-issues / babysit / standup | — | Nothing in this audit | Several run git or GitHub operations | **KHÔNG DÙNG** |
| `loop`, `schedule`, `CronCreate` | — | Nothing in this audit | Would run unattended turns past the phase stop points | **KHÔNG DÙNG** |
| Ahrefs MCP | — | — | Not authenticated | **KHÔNG DÙNG — [UNKNOWN]** |

---

## 3. Conflicts with the audit rules

| # | Skill | The conflict | Ledger ID |
|---|---|---|---|
| 1 | `gitnexus-work`, `gitnexus-lfg` | Both implement *and* gate their own commits (`detect_changes` gating every commit). That is a second git authority beside PHẦN III, and it edits code — forbidden in Phase 0/1. | `CFG-017` |
| 2 | `superpowers:finishing-a-development-branch` | Its whole subject is how to integrate finished work, including merging. PHẦN III reserves that for the owner. | `CFG-017` |
| 3 | `claude-mem:version-bump` | Tags, releases and publishes. `guard-bash.js` blocks `npm publish`, but nothing stops the tagging and GitHub-release steps. | `CFG-017` |
| 4 | `code-review` vs `gitnexus-review` vs `.claude/agents/code-reviewer` | Three reviewers for one job. | resolved above, no ID |
| 5 | `security-review` vs `.claude/agents/security-auditor` | Two security passes; the generic one does not know this app's threat model. | resolved above, no ID |
| 6 | `superpowers:using-superpowers` | Instructs that a skill MUST be invoked before any response, including clarifying questions. PHẦN I §6 puts this file above skills, and §4 caps skill loading per phase. | resolved by §6 precedence; declared each phase |

**None of these skills can run git in this session without passing
`guard-bash.js` first** — which is the real enforcement. But see `CFG-012`:
that guard's branch protection is currently **switched off**.

---

## 4. Gaps — what no skill covers

- **Measuring this app's own token spend per turn.** `token-budget` explains the
  model; nothing measures it. Done by hand via `availableTools({ context })`.
- **End-to-end latency and LLM calls per request.** Needs a live provider key.
  No skill substitutes for that, and it stays `[UNKNOWN]`.
- **Verifying repo visibility.** `gh` is not installed; no skill reads it.
- **The exposure classification.** Deciding what a public repo should not carry
  is a judgement about this business, and no skill holds that context.

---

## 5. Vòng v4 (2026-11-02) — bản kê lại theo manifest của phiên này

Nguồn: danh sách skill/agent/MCP trong manifest phiên 2026-11-02. Không đoán tên.

**Mới so với v2/v3:** project skills thêm `audit-performance`, `audit-security`, `audit-tokens`, `deploy-check`, `eval`, `gen-docs`, `migrate`, `new-provider`, `new-tool`, `ship`, `trace`, `verify` (lệnh trong `.claude/commands`); project agents `backend-engineer`, `frontend-engineer`, `database-architect`, `qa-tester`, `security-auditor`, `performance-optimizer`, `code-reviewer`, `technical-writer`, `ui-ux-designer`; plugin `agent-skills:*` (spec/plan/build/test/review/ship, security-and-hardening, performance-optimization, …), `mattpocock-skills:*`, `context-engineering:*`, các bundle `agentic-bundle-*`, `searchfit-seo:*`, `marketing-skills:*`, `canva:*`, `airtable:*`, `desktop-commander:*`, MCP `context7`, `gitnexus`, `repomix`, `claude-mem`, Claude Docs, Google Drive.

| Skill / agent | Phase | Việc cụ thể | Rủi ro | Quyết định |
|---|---|---|---|---|
| agent `security-auditor` (project) | 0 | 2 lát đọc tĩnh: biên server; thực thi/sandbox | đã từng bắn hộp thoại thật (2026-09-03) | `CÓ ĐIỀU KIỆN` — brief cấm chạy bất cứ thứ gì, chỉ Read/Grep/`git diff` |
| agent `code-reviewer` (project) | 0, 3 | 3 lát đọc: harness/provider; frontend lõi; frontend cài đặt. Phase 3: evaluator ngữ cảnh mới (không Edit/Write) | cùng họ Claude → thiên lệch tự ưu ái | `DÙNG` |
| `verify` (project) | 2, 3 | cổng DoD trước mỗi commit | — | `DÙNG` |
| `audit-security`, `audit-tokens`, `audit-performance` (project) | 1 | danh mục kiểm theo threat model của app | trùng PHẦN IV–VI → chỉ dùng làm checklist | `CÓ ĐIỀU KIỆN` |
| `superpowers:systematic-debugging` | 2 | khi test đỏ | — | `DÙNG` |
| `superpowers:test-driven-development` / `agent-skills:test` | 2 | test trước khi sửa mỗi ID | — | `DÙNG` |
| `superpowers:verification-before-completion` | 2–4 | bằng chứng trước khi nói "xong" | — | `DÙNG` |
| `superpowers:finishing-a-development-branch` | 4 | — | đưa menu merge/PR/giữ; chủ đã chốt "luôn push main" (memory `always-push-to-main`) | `KHÔNG DÙNG` |
| `claude-mem:version-bump`, `agent-skills:ship` | 4 | — | tự tag/release/publish → bị `guard-bash.js:178` chặn | `KHÔNG DÙNG` |
| `gitnexus:*` (impact/taint) | 1 | — | index chưa xác minh là mới; tốn token | `KHÔNG DÙNG` vòng này |
| `context7` | 2 | tra API thư viện khi sửa (e2b, glob) | — | `CÓ ĐIỀU KIỆN` |
| `searchfit-seo:*`, `marketing-skills:*`, `canva:*`, `airtable:*`, `agentic-bundle-aas-marketing-*`, `anthropic-skills:xlsx/pptx/docx` | — | không liên quan audit code | — | `KHÔNG DÙNG` |
| Google Drive / Claude Docs MCP | — | không gửi dữ liệu repo ra ngoài | rò chất xám | `KHÔNG DÙNG` |

Skill nạp Phase 0 v4: [] — chỉ dùng agent project `security-auditor`, `code-reviewer`.