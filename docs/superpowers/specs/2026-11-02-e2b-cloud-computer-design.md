# Máy tính đám mây chạy trên E2B, Vercel Sandbox làm dự phòng

Ngày: 2026-11-02

## Vấn đề

Máy tính đám mây của mỗi tài khoản (`sandbox_run`, phiên Python, `cloud_browser`,
máy chủ MCP stdio) chỉ chạy trên Vercel Sandbox gói Hobby: 10 máy cùng lúc, 5 giờ CPU
mỗi tháng, phiên dài nhất 45 phút, và phần khởi động helper chưa từng được kiểm trên
máy thật. Chủ dự án muốn có nhiều sức chạy hơn mà vẫn không tốn tiền.

Đã xét và bỏ:

- **Oracle Cloud Always Free.** Từ 2026 chỉ còn 2 OCPU và 12 GB, tối đa hai máy A1.
  Máy Ampere không có ảo hoá lồng, nên không chạy được Firecracker. Chủ dự án tạo máy
  không được.
- **Modal và Daytona.** Chủ dự án đã chọn E2B.

## Quyết định đã chốt với chủ dự án

- **E2B làm máy chính, Vercel Sandbox làm dự phòng.** Phương án A, chốt 2026-11-02.
- **Chỉ dùng gói Hobby, không gắn thẻ.** Hết credit thì E2B tự từ chối, không bao giờ
  thành hoá đơn.
- **Dùng hết credit.** Tài khoản có $100 hết hạn ngày 2027-12-01 và $5 không hết hạn.
  Mức trần mỗi tháng tự điều chỉnh để đến ngày hết hạn không còn credit bị bỏ phí.

## Sự thật dùng trong thiết kế, và nguồn

| Sự thật | Nguồn |
|---|---|
| Hobby: $100 một lần, 8 vCPU / 8 GiB tối đa, đĩa 10 GiB, chạy liên tục tối đa 1 giờ (tạm dừng thì tính lại), 20 máy cùng lúc, tạo 1 máy/giây, máy tạm dừng giữ vô thời hạn | docs.e2b.dev/billing (đọc 2026-11-02) |
| Giá: vCPU $0.000014/giây, RAM $0.0000045/GiB/giây; máy tạm dừng hoặc đã xoá không tính tiền | docs.e2b.dev/faq/calculate-sandbox-price |
| Tạm dừng giữ cả bộ nhớ lẫn ổ đĩa; `Sandbox.connect(id)` tự chạy tiếp; `lifecycle.onTimeout: 'pause'` | docs.e2b.dev/sandbox/persistence |
| `commands.run` luôn chạy `/bin/bash -l -c <cmd>` (login shell) | mã nguồn SDK `Commands.start` |
| Mã thoát khác 0 thì `run` và `CommandHandle.wait()` **ném** `CommandExitError` | mã nguồn SDK `wait()` |
| Cổng công khai: `${port}-${sandboxId}.e2b.app` | mã nguồn SDK `ConnectionConfig.getHost` |
| 401 → `AuthenticationError`, 429 → `RateLimitError`, 503 → `ServiceBusyError`, mã khác → `SandboxError` kèm `statusCode` | mã nguồn SDK `apiErrorFromCode` |
| Template `base`: Debian, Python 3, Node.js, git, curl, build-essential; người dùng `user`, thư mục `/home/user` | docs.e2b.dev/template/base-image |
| SDK `e2b` 2.62.0 tải được trên Node 22.16 dù khai báo `>=22.19` | chạy thử 2026-11-02 |

## Thiết kế

### 1. Một "máy" có hai nơi chạy

Code phía trên chỉ cần một đối tượng máy có các hàm sau: `runCommand`, `writeFiles`,
`readFileToBuffer`, `domain`, `update`, `extendTimeout`, `currentSession`, `stop`,
`delete`. Code phía trên gồm `runInSandbox`, `cloudBrowser/index.js` và `mcp/cloud.js`.
Thêm `server/e2b.js`, một adapter tạo ra đối tượng có đúng các hàm đó trên E2B. Code
phía trên không đổi.

`server/sandbox.js` chọn nơi chạy:

- `sandboxConfigured()`: đúng khi có `E2B_API_KEY` **hoặc** có cấu hình Vercel như trước.
  `SANDBOX_DISABLED=1` vẫn tắt tất cả.
- `machineForUser(userId)` thử E2B trước. Nếu E2B không dùng được, nó chuyển sang Vercel
  và gắn `standIn: true` cho máy. "Không dùng được" gồm các trường hợp sau:
  - không có key;
  - hết credit tháng này theo `freeTier`;
  - E2B trả 401, 402, 403 hoặc lỗi về credit, 429 (đủ 20 máy), 503;
  - mạng lỗi hoặc quá giờ khi tạo hay đánh thức máy.

  Lỗi xảy ra sau khi máy đã chạy, như một lệnh hỏng, thì báo lại như thường, không
  chuyển máy.
- `scratchMachine()`, dùng để kiểm máy chủ MCP lần đầu, theo cùng thứ tự.
- Khi E2B báo hết credit, gọi `freeTier.exhaust('e2b')`, để cả app thôi thử E2B cho
  đến tháng sau.

Máy dự phòng là một máy khác, không có file của máy E2B. `machineNote` nói thẳng điều
đó với model: "a stand-in computer… files from the usual one are not here".

### 2. Mỗi tài khoản một máy E2B, tìm lại được

- Bản ghi `user_settings.e2bMachine` = `{ id, cpu, memMb, paidUntil }`.
- Có `id` thì gọi `Sandbox.connect(id, { timeoutMs })`, máy đang tạm dừng sẽ chạy tiếp
  với nguyên bộ nhớ. Nếu nhận `NotFound` (máy đã bị xoá) thì xoá bản ghi và tạo máy mới.
- Không có bản ghi thì `Sandbox.list({ query: { metadata: { machine: sandboxName(userId) } } })`
  để tìm máy cũ; vẫn không có thì `Sandbox.create(template, { metadata, timeoutMs,
  lifecycle: { onTimeout: 'pause', autoResume: false } })`.
- **Hai nơi cùng tạo máy một lúc** (hai instance serverless): tạo xong, liệt kê lại theo
  metadata, giữ máy có `startedAt` cũ nhất và xoá những máy thừa vừa tạo.
- Trong một instance, các lời gọi đang chờ cùng một tài khoản dùng chung một lần khởi
  động (`starting` Map), giống `mcp/cloud.js`.
- Template lấy từ `E2B_TEMPLATE`, mặc định `base`.
- Rảnh 10 phút thì máy tự tạm dừng. Đó là lúc ngừng tính tiền, và Python cùng trình
  duyệt vẫn còn nguyên khi chạy tiếp.
- `extendTimeout(ms)` gọi `setTimeout(ms)`: kéo hạn tới `now + ms`.
- `stop()` gọi `pause()`. `delete()` gọi `kill()`.
- `domain(port)` trả `https://` + `getHost(port)`. `update()` không làm gì, vì E2B mở sẵn
  mọi cổng.
- `currentSession().cwd` = `/home/user`.

### 3. Chạy lệnh: bịt lại HAR-001 trên login shell của E2B

E2B luôn chạy `bash -l -c`, nên nếu lệnh chạy dưới quyền `user`, shell sẽ đọc
`~/.bash_profile` và `~/.profile` của tài khoản trước mỗi lệnh, kể cả lệnh khởi động
helper đang giữ key. Một trang web lừa model ghi thêm vào các file đó là đủ để chen mã
vào trước mọi lệnh sau. Đây đúng là lỗ HAR-001 mà `shellFor` đã bịt trên Vercel.

Cách bịt: **mọi lệnh gửi tới E2B đều chạy với `user: 'root'`, `cwd: '/home/user'`.**
Login shell của root chỉ đọc file root mới ghi được. Từ đó:

- Lệnh có `sudo: true` (`as_root`, khởi động helper ở chế độ root):
  `exec bash --noprofile --norc -c '<script>'`.
- Lệnh thường hạ quyền xuống tài khoản rồi mới chạy:
  `exec setpriv --reuid=<uid user> --regid=<gid user> --init-groups env HOME=/home/user
  USER=user LOGNAME=user bash --noprofile --norc -c '<script>'`.
  `setpriv` thuộc `util-linux`, gói thiết yếu của Debian.
- Lệnh chạy thường (không detached) được bọc thêm `timeout -k 5 <giây>` bên trong máy,
  để lệnh quá giờ chết thật chứ không thành tiến trình mồ côi. SDK được cho thêm 15 giây.
- `CommandExitError` được đổi thành `{ exitCode, stdout(), stderr() }`, đúng hình dạng
  Vercel trả. `wait()` của lệnh detached cũng đổi lỗi đó thành `{ exitCode }`. Các lỗi
  khác như mất kết nối hay quá giờ vẫn ném ra; `startAs` đã bỏ qua chúng.
- Lệnh detached đặt `timeoutMs` 10 phút cho luồng theo dõi. Tiến trình vẫn sống khi
  luồng đóng (SDK: "The command is not killed").

Root của tài khoản (`as_root`) vẫn ghi được file của root, và hành động đó đã được xếp
loại `sensitive`, luôn hỏi trước (`assessRisk`). Mức an toàn vì vậy giữ nguyên như trên
Vercel, nơi tài khoản cũng có sudo không mật khẩu.

### 4. File

- `writeFiles` gọi `files.write([{ path, data }])`. Đường dẫn tương đối được nối vào
  `/home/user`.
- `readFileToBuffer` gọi `files.read(path, { format: 'bytes' })` và đổi sang `Buffer`.
  File không tồn tại trả `null`, như Vercel.

### 5. Credit: dùng hết, không bao giờ vượt

`freeTier.js` có thêm dịch vụ `e2b`, tính bằng phần nghìn đô la (mills) như Exa:

- Hai bộ đếm: tháng này (`free:e2b:<YYYY-MM>`) và trọn đời (`free:e2b:total`).
  `spend('e2b')` cộng vào cả hai.
- Mức trần của tháng được tính từ những gì còn lại **đầu tháng**:
  - Trước `E2B_CREDIT_EXPIRES` (mặc định `2027-12-01`):
    trần = `max(0, 0.97 × E2B_CREDIT_MILLS − đã_dùng_trước_tháng) ÷ số_tháng_còn_lại`.
    Số tháng còn lại tính cả tháng này; từ 11/2026 đến 11/2027 là 13 tháng. Tháng nào dùng
    ít thì phần dư tự dồn sang các tháng sau.
  - Khi phần sắp hết hạn đã dùng xong, hoặc sau ngày hết hạn: trần bằng phần
    `0.97 × E2B_CREDIT_LASTING_MILLS` còn lại.
  - Mặc định `E2B_CREDIT_MILLS=100000` và `E2B_CREDIT_LASTING_MILLS=5000`, theo đúng số
    chủ dự án đưa ngày 2026-11-02.
- **Tính tiền theo thời gian giữ máy chạy, trả trước.** Mỗi lần tạo, đánh thức hay kéo hạn
  tới `until`, trả cho `until − max(now, paidUntil)` theo giá × (cpu, memMb của máy).
  Máy tự tạm dừng đúng lúc hết hạn, nên con số này gần như đúng bằng số E2B sẽ tính.
  Không đủ tiền thì không mở máy E2B và chuyển sang Vercel.
- Giá: vCPU 0.014 mills/giây, RAM 0.0045 mills/GiB/giây. Ghi kèm ngày tra giá.
- Máy dùng để kiểm MCP trả trước 6 phút cho cả app.
- Bảng Free allowances của admin có thêm dòng `e2b`, vì `freeTierReport` lặp qua mọi dịch vụ.
- `chargeCloud`, ngân sách số hành động mỗi ngày của từng tài khoản và cả app, giữ nguyên
  cho cả hai nơi chạy.

### 6. Trình duyệt đám mây trên E2B

- `@sparticuz/chromium` cùng mẹo `VERCEL=1` tự mang theo thư viện của Chromium. Glibc
  của Debian mới hơn AL2023, nên dự kiến chạy được. **Phải kiểm trên máy thật.**
- Dòng cài font hiện chỉ thử `dnf`, `microdnf` và `yum`. Thêm nhánh `apt-get`
  (`fonts-noto-core fonts-dejavu-core`) cho Debian.
- CSP thêm `https://*.e2b.app` vào `img-src` và `wss://*.e2b.app` vào `connect-src`, ở
  **cả** `securityHeaders.js` và `vercel.json`. `test/deploy` sẽ bắt nếu hai chỗ lệch nhau.

### 7. Template riêng (không bắt buộc)

Thêm `npm run e2b:template` (`scripts/e2b-template.mjs`): dựng template `synapsez-computer`
từ `base` với 2 vCPU, 2 GiB và font. Chủ dự án chạy một lần, rồi đặt
`E2B_TEMPLATE=synapsez-computer` trên Vercel. Không có template này thì dùng `base`.

## Kiểm chứng

- **`test/e2b.test.mjs`**, chạy trong `npm test` với SDK giả, không cần mạng. Kiểm:
  - chọn nơi chạy và chuyển sang Vercel cho từng loại lỗi;
  - lệnh luôn chạy dưới root, và lệnh thường có `setpriv … --noprofile --norc`;
  - `CommandExitError` được đổi thành mã thoát;
  - `wait()` của lệnh detached;
  - tìm lại máy theo bản ghi, theo metadata, và xử lý hai nơi cùng tạo máy;
  - tính tiền trả trước, không tính trùng phần đã trả;
  - mức trần tháng (dồn phần dư, hết hạn, $5 còn lại);
  - đường dẫn tương đối; file không có trả `null`; ghi chú máy dự phòng.
- Cập nhật `test/features` (`sandboxConfigured` có E2B) và `test/deploy` (CSP).
- **`npm run e2b:probe`** (`scripts/e2b-probe.mjs`) chạy trên E2B thật bằng key trong
  `.env`, không nằm trong `npm test`. Nó kiểm:
  - `whoami` và `id`;
  - một `~/.profile` cài mìn **không** chạy;
  - `setpriv` có mặt;
  - tiến trình nền sống sau khi luồng theo dõi đóng;
  - cổng công khai qua https;
  - tạm dừng rồi chạy tiếp vẫn giữ tiến trình và file;
  - tiền thật đã dùng.

  Mỗi lần chạy tốn khoảng một xu.
- Những gì chưa kiểm trên máy thật sẽ được ghi rõ trong báo cáo, không nói là xong.

## Ngoài phạm vi

- Lỗi Vercel Sandbox mà chủ dự án nhắc ngày 2026-11-02 chưa có thông báo lỗi cụ thể. Sẽ
  xử lý riêng khi có ảnh chụp hoặc log.
- Webhook vòng đời của E2B để đối chiếu chi phí thật: trả trước đã đủ chính xác.
- Xoá máy E2B tạm dừng quá lâu: máy tạm dừng không tốn tiền.
