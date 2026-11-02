# Máy tính đám mây trên E2B: kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Máy tính đám mây của mỗi tài khoản chạy trên E2B, tự chuyển sang Vercel Sandbox khi
E2B không dùng được, và tiêu hết credit E2B trước ngày hết hạn mà không bao giờ vượt.

**Architecture:** `server/e2b.js` tạo một đối tượng "máy" có đúng các hàm mà
`server/sandbox.js`, `cloudBrowser/index.js` và `mcp/cloud.js` đang gọi trên Vercel Sandbox.
`sandbox.js` chọn E2B trước rồi đến Vercel. `freeTier.js` có thêm dịch vụ `e2b` với mức trần
tháng tự điều chỉnh.

**Tech Stack:** Node 22 ESM, Express 5, `e2b` 2.62.0, PGlite trong test, test tự viết
(`section`/`check`).

Spec: `docs/superpowers/specs/2026-11-02-e2b-cloud-computer-design.md`.

## Global Constraints

- Mỗi câu lỗi phía server là một câu trọn vẹn viết ngay trong `new Error(…)`, và có bản
  dịch trong `server/i18n/vi.js`. `test/server-i18n` sẽ bắt câu nào thiếu.
- Mọi lệnh gửi tới E2B chạy với `user: 'root'` và `cwd: '/home/user'`. Lệnh không phải
  root phải hạ quyền bằng `setpriv`, rồi chạy `bash --noprofile --norc`.
- Lời gọi E2B tốn tiền phải đi qua `freeTier` (`allowance`/`spend`, dịch vụ `'e2b'`,
  đơn vị mills).
- CSP ở `server/securityHeaders.js` và `vercel.json` phải giống hệt nhau.
- Code mới theo giọng comment của repo: giải thích *tại sao*, câu tiếng Anh trọn vẹn.

## File Structure

- Tạo `server/e2b.js`: adapter, tìm hoặc tạo máy, tính tiền trả trước, nhận diện lỗi. Có
  `__testing.useSdk`.
- Sửa `server/freeTier.js`: dịch vụ `e2b`, bộ đếm trọn đời, mức trần tháng tự điều chỉnh.
- Sửa `server/sandbox.js`: chọn nơi chạy, chuyển sang Vercel, `standIn`, `machineNote`.
- Sửa `server/cloudBrowser/index.js`: nhánh `apt-get` cho font.
- Sửa `server/securityHeaders.js` và `vercel.json`: CSP thêm `*.e2b.app`.
- Sửa `server/i18n/vi.js`: câu mới.
- Tạo `test/e2b.test.mjs`, rồi thêm vào script `test` trong `package.json`.
- Tạo `scripts/e2b-probe.mjs` và `scripts/e2b-template.mjs`, cùng npm script
  `e2b:probe` và `e2b:template`.
- Sửa `README.md`: biến môi trường E2B.

---

### Task 1: Credit E2B trong `freeTier.js`

**Files:** Sửa `server/freeTier.js`. Test: `test/e2b.test.mjs` (tạo mới, mục "credit").

**Interfaces:**
- Tạo ra: `e2bMonthCap({ usedBefore, now, env }) → number` (mills, thuần, không gọi DB).
- Tạo ra: `allowance('e2b')` trả `{ left, limit }`, với `limit` = trần tháng.
- Tạo ra: `spend('e2b', mills)` cộng vào cả bộ đếm tháng lẫn `free:e2b:total`.

- [ ] Viết các check, cho chạy và thấy chúng thất bại:
  - 13 tháng còn lại, chưa dùng gì: trần = `floor(97000/13)` = 7461.
  - Đầu tháng đã dùng 30000, còn 10 tháng: trần = `floor(67000/10)` = 6700, tức phần dư
    đã dồn sang.
  - Phần sắp hết hạn đã dùng hết (usedBefore ≥ 97000): trần = 4850 − (usedBefore − 100000,
    nếu dương).
  - Sau 2027-12-01: trần = phần còn lại của 4850.
  - Bộ đếm tháng và bộ đếm trọn đời cùng tăng sau `spend('e2b', 25)`.
  - `allowance('e2b').left` = trần − đã dùng tháng này.
- [ ] Viết code: thêm `e2bMonthCap`, thêm `e2b` vào `TIERS` với `capFor` bất đồng bộ
  (đọc `free:e2b:total` và bộ đếm tháng), cho `allowance` dùng `capFor` khi có, và cho
  `spend` cộng thêm vào bộ đếm trọn đời của `e2b`. Bộ đếm trọn đời hết hạn năm 2100.
- [ ] Chạy `node test/e2b.test.mjs`: phải pass.
- [ ] Commit.

### Task 2: Adapter `server/e2b.js`

**Files:** Tạo `server/e2b.js`. Test: `test/e2b.test.mjs` (mục "machine").

**Interfaces:**
- Dùng `allowance`/`spend`/`exhaust` (Task 1), `getStore().getUserSetting`/`setUserSetting`,
  và `sandboxName` (truyền vào để tránh import vòng).
- Tạo ra: `e2bConfigured(env) → boolean`.
- Tạo ra: `e2bMachineFor(userId, name, { signal }) → Promise<Machine>`.
- Tạo ra: `e2bScratch({ signal }) → Promise<Machine>`.
- Tạo ra: `e2bUnavailable(err) → 'credit' | 'busy' | 'auth' | 'down' | null`.
- Tạo ra: `class E2BOutOfCredit extends Error`.
- `Machine`:
  - `runCommand({ cmd, args, env, sudo, detached, timeoutMs, signal })` trả
    `{ exitCode, stdout(), stderr() }`, hoặc `{ wait() }` với lệnh detached;
  - `writeFiles([{ path, content: Buffer }])`;
  - `readFileToBuffer({ path })` trả `Buffer | null`;
  - `domain(port)` trả `string`;
  - `update()`, `extendTimeout(ms)`, `currentSession()` trả `{ cwd }`;
  - `stop()`, `delete()`;
  - thuộc tính `provider = 'e2b'`.
- [ ] Viết các check với SDK giả, rồi cho chạy và thấy chúng thất bại:
  - Lệnh thường chạy với `user: 'root'` và `cwd: '/home/user'`. Chuỗi lệnh có `setpriv`,
    `--init-groups`, `HOME=/home/user`, `bash --noprofile --norc -c` và `timeout -k 5`.
  - Lệnh `sudo` không có `setpriv`.
  - Script có dấu `'` được trích dẫn đúng.
  - Môi trường được truyền qua `envs`.
  - `CommandExitError` (mã 3) được đổi thành `exitCode 3`, giữ nguyên stdout và stderr.
  - `wait()` của lệnh detached đổi `CommandExitError` (143) thành `{ exitCode: 143 }`.
    Các lỗi khác vẫn ném ra.
  - Có bản ghi `id` thì gọi `connect`. `NotFound` thì xoá bản ghi rồi tạo máy mới.
  - Không có bản ghi: tìm theo metadata trước, rồi mới tạo.
  - Hai máy cùng metadata: giữ máy cũ nhất, xoá máy vừa tạo.
  - Tính tiền: lần tạo đầu trả cho 10 phút. `extendTimeout` 15 phút chỉ trả phần vượt
    `paidUntil`. Allowance không đủ thì ném `E2BOutOfCredit` và không tạo máy.
  - `readFileToBuffer` khi file không có trả `null`. Đường dẫn tương đối được nối vào
    `/home/user`.
  - `domain(3000)` = `https://3000-<id>.e2b.app`.
  - `e2bUnavailable`: 429 trả 'busy', 503 trả 'down', 401 trả 'auth', 402 trả 'credit',
    `"…credits…"` trả 'credit', lỗi mạng trả 'down', `CommandExitError` trả null.
- [ ] Viết code theo các mục 2, 3, 4 và 5 của spec.
- [ ] Chạy test: phải pass.
- [ ] Commit.

### Task 3: Chọn nơi chạy trong `server/sandbox.js`

**Files:** Sửa `server/sandbox.js`. Test: `test/e2b.test.mjs` (mục "choice"),
`test/features.test.mjs` (dòng 146–149).

**Interfaces:**
- Dùng các hàm của Task 2.
- `machineForUser(userId)`, `scratchMachine()`, `discardMachine()`, `sandboxConfigured(env)`,
  `machineNote(home, { standIn })`: tên giữ nguyên, hành vi mới.
- [ ] Viết các check, cho chạy và thấy chúng thất bại:
  - Có `E2B_API_KEY` thì được tính là đã cấu hình.
  - E2B ném `RateLimitError`, `E2BOutOfCredit` hoặc 503: chuyển sang Vercel, máy có
    `standIn === true`.
  - E2B báo hết credit thì gọi `exhaust('e2b')`.
  - Không có Vercel thì ném câu `machineStartError`.
  - `machineNote(home, { standIn: true })` có "stand-in".
  - `forDisplay` (render.js) vẫn bỏ được ghi chú này (`test/features` dòng 1337).
- [ ] Viết code: `pickMachine`, gắn `standIn`; `runInSandbox` truyền `standIn` vào
  `machineNote`.
- [ ] Chạy `node test/e2b.test.mjs`, `node test/features.test.mjs` và
  `node test/cloudBrowser.test.mjs`.
- [ ] Commit.

### Task 4: CSP, font, chữ, tài liệu

**Files:** `server/securityHeaders.js`, `vercel.json`, `server/cloudBrowser/index.js`
(`installLines`), `server/i18n/vi.js`, `README.md`, `package.json` (script `test`).

- [ ] CSP thêm `https://*.e2b.app` vào `img-src` và `wss://*.e2b.app` vào `connect-src`, ở
  cả hai file. Chạy `node test/deploy.test.mjs`.
- [ ] `installLines` thêm nhánh `apt-get` (`sudo -n apt-get install -y -q fonts-noto-core
  fonts-dejavu-core`). Chạy `node test/cloudBrowser.test.mjs`.
- [ ] Thêm câu tiếng Việt cho mọi câu lỗi mới. Chạy `node test/server-i18n.test.mjs`.
- [ ] Thêm `node test/e2b.test.mjs` vào chuỗi `npm test`. Viết mục README về E2B.
- [ ] Commit.

### Task 5: Probe và template

**Files:** tạo `scripts/e2b-probe.mjs` và `scripts/e2b-template.mjs`, thêm npm script.

- [ ] Probe dùng adapter thật (`e2bScratch`) và key trong `.env`. Nó kiểm từng điều trong
  mục "Kiểm chứng" của spec, in ✓/✗, và luôn `kill` máy ở `finally`.
- [ ] Template: `Template().fromBaseImage().aptInstall([...fonts], …)` rồi
  `Template.build(t, 'synapsez-computer', { cpuCount: 2, memoryMB: 2048 })`.
- [ ] `npm run lint` và `npm run typecheck`.
- [ ] Commit.

### Task 6: Gate, review, đẩy lên `main`

- [ ] `npm run gate` (cả bộ test, lint, typecheck). Đọc lại diff từng dòng.
- [ ] Nếu có `E2B_API_KEY` và chủ dự án đồng ý: `npm run e2b:probe`, ghi kết quả thật.
- [ ] Merge fast-forward vào `main`, rồi push (memory: always-push-to-main).
