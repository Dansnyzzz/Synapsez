# HỢP ĐỒNG KIỂM CHỨNG — vòng v3 (2026-10-04)

Điền theo AUDIT_RULES v3 §3. Mỗi dòng có nhãn bằng chứng (§4).

| Trường | Giá trị | Bằng chứng |
|---|---|---|
| REPO | `D:\AI remote` | [FACT] cwd |
| REMOTE | `https://github.com/Dansnyzzz/Synapsez.git` (đổi tên từ `AI-Agency-Remote.git`) | [FACT] `git remote -v` |
| VISIBILITY | **Không công khai lúc audit.** AUDIT_RULES ghi "PUBLIC (chủ project xác nhận)", nhưng API GitHub ẩn danh trả **404** cho `repos/Dansnyzzz/Synapsez`, tức private (hoặc không đọc được ẩn danh). Audit vẫn xử như public theo §0.1b (bảo vệ chất xám không phụ thuộc vào cờ hôm nay). | [FACT] `Invoke-RestMethod https://api.github.com/repos/Dansnyzzz/Synapsez` → `404`; `gh` chưa cài |
| SHELL CỦA AGENT | **PowerShell 5.1.** Tool Bash hỏng trên máy này (`D:\Git\usr\bin\bash.exe` không có). Các lệnh bash trong AUDIT_RULES được chạy bản PowerShell tương đương. | [FACT] memory `machine-bash-broken`; môi trường phiên |
| NHÁNH LÚC BẮT ĐẦU | `main` @ `58b1ab4` (trùng `origin/main`), cây sạch. AUDIT_RULES ghi `model-capability-audit` — đã lỗi thời. | [FACT] `git status`, `git log origin/main -1` |
| NODE | `22` | [FACT] `.nvmrc:1`; `package.json` `engines.node >=20` |
| CMD_INSTALL | `npm ci` | [FACT] `.github/workflows/ci.yml` |
| CMD_TEST | `npm test` (chuỗi 48 file `test/*.test.mjs`) | [FACT] `package.json` `scripts.test` |
| CMD_LINT | `npm run lint` → `eslint .` | [FACT] `package.json` |
| CMD_TYPECHECK | `npm run typecheck` → `node scripts/typecheck.js` (ratchet theo file, trần trong `.typecheck-baseline.json`) | [FACT] `package.json` |
| CMD_BUILD | **NONE** — không có bước build; frontend ES module chạy thẳng, `api/index.js` là hàm Vercel. Cổng "build" = gate + test deploy (`test/deploy.test.mjs` chạy đường `VERCEL=1`). | [FACT] `package.json` không có `build` |
| CMD_RUN_LOCAL | `npm start` (`scripts/launch.js`) · `npm run dev` | [FACT] `package.json` |
| GATE | `npm run gate` → `.claude/hooks/gate.js run` → `npm run lint` · `npm run test:hooks` · `npm run eval` · `npm run typecheck` · `npm test` | [FACT] `.claude/hooks/gate.js:393-405` |
| Ngoài gate (chỉ CI) | `npm run test:ui`, `npm run test:sandbox` (cần Chromium) | [FACT] `gate.js:387-391`, `ci.yml` |
| ENTRYPOINT | Vercel: `api/index.js` (mọi `/api/*` rewrite tới đây) · local: `server/index.js` · tĩnh: `public/` (CDN Vercel) | [FACT] `vercel.json` `rewrites`, `functions` |
| LLM PROVIDERS | Anthropic `https://api.anthropic.com` · OpenAI `https://api.openai.com` · Google Gemini `https://generativelanguage.googleapis.com` · OpenRouter `https://openrouter.ai` (Auto = `openrouter/free`) · OrcaRouter `https://api.orcarouter.ai/v1`. Key: **người dùng tự nhập key** (BYOK) hoặc key chung của deployment; loại key (commercial/consumer) do người dùng chọn — [UNKNOWN] từng key cụ thể. | [FACT] `server/models.js:9-10,457,466,477,488`; `server/providers/index.js:16-17` |
| PROVIDER TERMS | **Anthropic API:** không dùng để train nếu không cho phép; nội dung hội thoại không giữ mặc định, trừ "Covered Models" giữ 30 ngày; ZDR theo hợp đồng sales. **Gemini API free tier:** Google *dùng* prompt/response để cải thiện sản phẩm, *người duyệt có thể đọc*; chỉ Paid Services mới không train; free tier cấm phục vụ người dùng EEA/CH/UK; ≥18 tuổi. **OpenRouter:** `data_collection` mặc định `allow` (provider có thể lưu/train); `deny` = chỉ provider không thu; `zdr:true` = chỉ endpoint ZDR; chính sách của OpenRouter tách riêng. **OpenAI:** [UNKNOWN] chưa mở trang gốc vòng này. | [FACT] platform.claude.com/docs/en/manage-claude/api-and-data-retention; ai.google.dev/gemini-api/terms; openrouter.ai/docs/guides/routing/provider-selection (đọc 2026-10-04) |
| EXTERNAL APIS | Xem `audit/DATAFLOW.md` (đủ danh sách host + trường dữ liệu). | |
| DEPLOY | Vercel Hobby. **Push `main` tự deploy production** — [INFER mạnh]: commit `58b1ab4` lúc 15:41:38 UTC, production `Last-Modified: 15:43:07 GMT` (~90s sau). Không có workflow deploy trong repo → Vercel Git integration (cấu hình ngoài repo). | [FACT] `git log -1 --format=%cI`; `HEAD https://synapsez.vercel.app/` |
| PROD URL | `https://synapsez.vercel.app` | [FACT] `server/tools/images.js:19`, `sports.js:21` (User-Agent); HEAD → 200, `Server: Vercel` |
| Vercel insights trên prod | `/_vercel/insights/script.js` → 200 · `/_vercel/speed-insights/script.js` → 200 (đã bật trong dashboard, chưa có trang nào nạp) | [FACT] HEAD 2026-10-04 |

## Baseline gate (trước khi sửa) — xem `audit/BASELINE.md` mục v3

---

# HỢP ĐỒNG KIỂM CHỨNG — vòng v4 (2026-11-02, AUDIT_RULES v4, AUTO)

Phạm vi: `502717f..a7098d1` (103 commit, 190 file, +37.833/−2.983 dòng) + các mục toàn cục v4 mới (SBX/WF/HC/KB/QC/UI).
Chỉ ghi các dòng đổi so với v3; dòng không nhắc = như v3.

| Trường | Giá trị v4 | Bằng chứng |
|---|---|---|
| VISIBILITY | **PUBLIC** (đổi so với v3: lúc đó API ẩn danh trả 404) | [FACT] `Invoke-RestMethod https://api.github.com/repos/Dansnyzzz/Synapsez` → `visibility=public private=False` (2026-11-02) |
| SHELL CỦA AGENT | PowerShell 5.1 (tool Bash vẫn hỏng) | [FACT] memory `machine-bash-broken`; phiên này |
| NHÁNH LÚC BẮT ĐẦU | `main` @ `a7098d1` (= `origin/main`). Cây có 3 mục untracked của chủ: `.env.example`, `.vscode/`, `Exa Deep Research-3.4.1-v1/` — không phải của audit, không commit | [FACT] `git status` đầu phiên |
| SANDBOX CỦA AGENT AUDIT | **KHÔNG HỖ TRỢ** — Windows gốc. Tài liệu: "Native Windows is not supported… run Claude Code inside a WSL2 distribution"; khoá bắt buộc là `sandbox.failIfUnavailable: true` (+ `sandbox.enabled: true`, `allowUnsandboxedCommands: false`). Không có khoá `sandbox` nào trong `.claude/settings.json` hay `~/.claude/settings.json`. → CFG-033 | [FACT] https://code.claude.com/docs/en/sandboxing (đọc 2026-11-02); `.claude/settings.json` |
| LỚP QUYỀN CỦA AGENT | `deny` Read `.env`/`.env.*`/`worker/.env*`/`data/pgdata/**`; `guard-bash.js` chặn force-push (`:125`), `reset --hard`/`clean -f` (`:129`), xoá `.env` (`:147`). **Không** chặn `--no-verify` — nhưng repo không có git hook nào (`core.hooksPath` trống, `.git/hooks` chỉ `*.sample`) nên cờ này không vượt được gì hôm nay | [FACT] `.claude/settings.json`; `.claude/hooks/guard-bash.js:116-186`; `git config --get core.hooksPath` |
| NODE | `22` (`.nvmrc`); máy: v22.16.0 | [FACT] |
| CMD_TEST | `npm test` — **51** file `test/*.test.mjs` (thêm `database`, `e2b`) | [FACT] `package.json` `scripts.test` |
| GATE | như v3: `.claude/hooks/gate.js run` → lint · test:hooks · eval · typecheck · test | [FACT] |
| TYPECHECK BASELINE | `total: 296` (v3: 315 → 306 → 296; co lại) | [FACT] `.typecheck-baseline.json` |
| LLM PROVIDERS | như v3 + nhà cung cấp dịch vụ ngoài mới nhận dữ liệu: **E2B** (máy tính đám mây, `server/e2b.js`), Exa (search/code_context), Stack Exchange; xem `DATAFLOW.md` mục v4 | [FACT] `server/e2b.js`, `server/tools/codeContext.js`, `server/search.js` |
| DB | Supabase Postgres (Transaction pooler, cổng 6543) thay Neon (Neon 402 do pinger, 2026-10-19) | [FACT] `.claude/commands/deploy-check.md` diff; `docs/database.md` |
| CSP | `connect-src 'self' wss://*.e2b.app wss://*.vercel.run`; `img-src … https://*.e2b.app https://*.vercel.run` (mở rộng so với v3) | [FACT] `vercel.json` diff |
| DEPLOY / PROD URL | như v3: push `main` → Vercel tự deploy; `https://synapsez.vercel.app` | [FACT] v3 |
| SECRET SCAN | `gitleaks` không cài. Quét regex hình dạng key (Anthropic/OpenRouter/OrcaRouter/OpenAI/Google/GitHub/Slack/Notion/E2B/Google OAuth/PEM/URL Postgres có mật khẩu) trên mọi dòng thêm `502717f..HEAD` và toàn cây HEAD: chỉ key giả trong test (`features0123…`) và placeholder tài liệu. `.env*` chưa từng vào lịch sử; `client_secret*.json` đã ignore | [FACT] lệnh quét phiên này |
| `npm audit` | prod: 3 moderate (e2b → glob 13.0.6 → minimatch 10.2.6); tất cả: 9 moderate; 0 high/critical | [FACT] `npm audit --omit=dev --json` |
