# Đọc ảnh như Claude: thumbnail trong thẻ lệnh, popup và lightbox

Ngày: 2026-10-19

## Vấn đề

Chủ dự án gửi ảnh chụp Claude đang kiểm toán một bộ hình: thẻ "Ran 9 commands,
read 3 files" khi đóng vẫn cho thấy **những ảnh AI đã xem** (thumbnail bên phải,
"+33" khi nhiều hơn), rê chuột thấy ảnh lớn, bấm vào là lightbox có mũi tên. Đó
là minh bạch: người dùng biết AI đã nhìn gì mà không phải mở từng dòng.

App hiện tại không làm được điều đó, và không chỉ vì giao diện:

- `read_file` trên một file PNG đọc nó **như văn bản UTF-8** (`worker/tools.js`,
  `readFile`) — model nhận về chữ rác, tốn token, không thấy gì.
- `look_at` là cách duy nhất để model "nhìn", nhưng nó là một thẻ riêng, không có
  ảnh, và không đọc được file trên máy cloud: muốn xem 37 hình trên máy cloud thì
  model phải `download` từng hình, mỗi hình thành một thẻ file.
- Thẻ "Ran … commands" là thẻ có viền, dấu ✓, tiêu đề đậm — khác hẳn Claude.

## Quyết định đã chốt với chủ dự án

1. **Đọc ảnh đầy đủ**: `read_file` trên ảnh ở máy người dùng hiện ảnh và đọc nội
   dung trong cùng một bước; `look_at` đọc được ảnh/PDF trên máy cloud theo đường
   dẫn; `look_at` trở thành dòng "Read <tên>" có ảnh trong thẻ lệnh.
2. **Phạm vi phong cách Claude 1:1**: chỉ thẻ lệnh + đọc ảnh. Thẻ trình duyệt/máy
   tính vẫn mở sẵn để xem nó làm (yêu cầu 2026-10-07), nhưng screenshot có popup +
   lightbox và dải thumbnail khi gập. Các tool đơn lẻ khác giữ thẻ riêng.
3. **Duyệt thiết kế kèm các điểm cố ý khác Claude** (mục "Khác Claude có chủ đích").

## Hai lựa chọn kiến trúc

**Ảnh đi ra màn hình bằng kênh `shot` có sẵn**, không thêm trường mới. Ảnh được
lưu thành attachment `origin: 'step'` và kết quả tool mang `shot: { id, name }`.
`shot` đã được dạy ở mọi chỗ cần: xoá theo chat (`chatId`), ẩn khi chia sẻ
(`PUBLISHABLE_TOOLS` không có `read_file`, `look_at`, `sandbox_run`), sao chép id
khi chia sẻ (`chatShare.js` `swap`), `referencedFiles`. Thêm trường `picture`
riêng thì phải dạy lại năm chỗ — đúng loại lỗi "quên một trường" mà các comment
trong `execute.js` ghi lại hai lần.

**Worker thu nhỏ ảnh trước khi gửi.** Vercel giới hạn body 4.5MB; một PNG 6MB gửi
nguyên sẽ hỏng trên bản deploy dù chạy tốt ở máy. `@napi-rs/canvas` đã có trong
`dependencies` (dùng ở `server/imageGround.js`), nên cả worker lẫn server đều có
thể thu nhỏ — đều là best-effort.

## Thiết kế

### 1. Tool

**Ảnh "đã xem"** — một bản để xem, lưu với giới hạn riêng (không phải 80KB của
screenshot):

| | Giá trị |
|---|---|
| Cạnh dài tối đa của bản xem | 1600px |
| Dung lượng tối đa lưu | 1.5MB |
| Thumbnail kèm theo | cạnh dài 420px, JPEG 0.72 (như `thumbnail.js`), vào cột `thumb` |
| Định dạng | PNG nếu có thể trong suốt (`mayBeTransparent`), còn lại JPEG 0.85 |

`keepStepShot` học thêm hai dạng đầu vào: `shot.id` có sẵn (ảnh đã là file của
tài khoản — trả nguyên `{ id, name }`, không sao chép), và `shot.name` (ảnh một
bước đã đọc — giới hạn 1.5MB, thu nhỏ nếu cần và làm được, kèm thumbnail). Lưu
thất bại vẫn trả `null` và không làm hỏng bước, như cũ.

**`read_file` trên ảnh** (png, jpg, jpeg, webp, gif, bmp; nhận theo đuôi file và
byte đầu):

1. Worker thu nhỏ còn ≤1600px. Không nạp được canvas thì gửi nguyên nếu ≤2.5MB
   (base64 vẫn dưới 4.5MB), lớn hơn thì báo lỗi rõ ràng.
2. Worker trả `{ text, shot: { data, mime, name, path } }` — `text` là một dòng:
   "Figure_4.png — ảnh PNG 1600×1200, 240 KB". Cả nhánh chạy trong tiến trình
   (`inProcessImplementations`) lẫn nhánh worker đều đi qua `keepStepShot`.
3. `executeTool` (server) thấy `read_file` có `shot.id` thì cho một model nhìn được
   đọc ảnh — cùng `see()` mà `look_at` dùng, qua `groundedImage` — rồi trả
   `text` + phần đọc được (bọc `untrusted`) + một dòng nói file id để `look_at`
   hỏi lại câu cụ thể.
4. Không model nào đọc được: `isError: true`, nói rõ lý do; ảnh vẫn hiện.

**`look_at`**:

- Thêm tham số `path`: ảnh hoặc PDF trên máy cloud của tài khoản (máy của
  `sandbox_run`). Qua `chargeCloud` + `machineForUser` + `readFileToBuffer`, cùng
  giới hạn `LOOK_MAX_BYTES`/`LOOK_MAX_PDF_BYTES`. Không có máy cloud → lỗi nói dùng
  `read_file` cho file trên máy người dùng.
- Mọi **ảnh** nó đọc trả về `shot`: `file_id` → chính file đó (đã kiểm tra thuộc
  tài khoản qua `getAttachment`); `url` và `path` → lưu bản xem như trên. PDF không
  có ảnh.
- Mô tả tool chỉ thêm đúng một câu cho `path` (ngân sách token).

### 2. Thẻ lệnh, 1:1 Claude (`data-family="work"`)

`look_at` vào `WORK_KINDS` với loại `read`. Mọi dòng loại `read` nói "Read
<tên>" / "Đọc <tên>" (khoá mới `work.readVerb`), tên lấy từ `path`, đoạn cuối
của `url`, hoặc `shot.name` khi kết quả về.

**Gập** — một dòng chữ xám, không viền, không nền, không ✓:

```
Read 36 files, ran 34 commands (1 failed) ›              +33 [▣][▣][▣]
```

- Tóm tắt theo thứ tự lần đầu xuất hiện (như hiện nay); lỗi nằm ngay sau loại của
  nó: "(1 failed)" / "(1 lỗi)" (khoá `work.failed`). Bỏ cụm "N lỗi" riêng ở thẻ lệnh.
- Mũi tên › đứng ngay sau chữ, không dạt về mép phải.
- Dải thumbnail dạt phải: **3 ảnh mới nhất** theo thứ tự đọc; nhiều hơn thì
  "+N" (N = tổng − 3) đứng trước. Ảnh cao cố định, rộng theo tỉ lệ, bo góc, nền trắng.
- Đang chạy: spinner trước tiêu đề, tiêu đề là bước mới nhất (như hiện nay), đồng
  hồ chạy. Khi tiêu đề đổi, chữ cũ mờ đi trong lúc chữ mới hiện lên (~220ms).
- Rê chuột: chữ sáng lên.

**Mở**:

- Mũi tên xoay xuống; dải thumbnail ở dòng tiêu đề ẩn đi.
- Bên dưới là một hộp viền 1px bo 12px; mỗi bước một dòng, cách nhau bằng đường kẻ
  mảnh. Động từ màu xám, tên file sáng ("Read **Figure_4.png** ›"); lệnh vẫn mờ,
  monospace sau tiêu đề của model. Thumbnail ở mép phải dòng.
- Rê vào tiêu đề dòng: tooltip chữ đầy đủ. Tên file: tooltip đường dẫn đầy đủ.
- Không ✓ trên dòng thành công; spinner khi đang chạy; ✗ đỏ khi lỗi.
- Thời gian chạy chuyển từ dòng vào trong phần mở của dòng.

**Mở một dòng ảnh**: `file_path:` (monospace) + đường dẫn (bấm mở lightbox), ảnh
lớn (cao tối đa 480px, bo góc, nền trắng), rồi phần model đọc được, rồi thời gian.

Hành vi tự mở/tự đóng giữ nguyên: dòng đang chạy mở, xong thì gập trừ khi người
dùng đã bấm; lỗi thì để mở.

**Thẻ trình duyệt/máy tính** giữ bố cục cũ, thêm: dải thumbnail khi gập, popup và
lightbox cho screenshot (bấm screenshot không còn mở trình xem file).

### 3. Popup và lightbox — `public/js/gallery.js`

Một module riêng, không phụ thuộc `render.js`; `render.js` đăng ký danh sách ảnh
của mỗi thẻ (`WeakMap` nút thẻ → hàm lấy ảnh). Sự kiện uỷ quyền trên `document`,
cài một lần, lười (không chạm `document` khi được import trong Node).

**Popup khi rê chuột** (chỉ `(hover: hover)`): sau ~300ms, một thẻ ~440px phía
trên thumbnail (không đủ chỗ thì phía dưới, kẹp trong khung nhìn): ảnh + chân
"Read · 1 of 3". Biến mất khi rời chuột, cuộn trang hoặc bấm.

**Lightbox khi bấm** (hoặc Enter/Space trên thumbnail):

- Nền tối phủ toàn app, ảnh giữa màn hình (tối đa 92vw × 80vh), bo góc, nền trắng.
- Trái dưới: nhãn của bước ("Read", "Click #2"). Giữa dưới: ‹ "2 of 3" ›, mũi tên
  mờ ở hai đầu. Phải trên: ✕.
- ←/→, Home/End, Esc; vuốt trên cảm ứng; bấm nền để đóng. Ảnh trượt ngang khi
  chuyển; nạp trước ảnh kế bên.
- `role="dialog"` + `aria-modal`, giữ focus trong hộp, trả focus về thumbnail khi
  đóng, `alt` là tên file.
- `prefers-reduced-motion`: không trượt, không mờ dần.

Thumbnail dùng `/api/attachments/:id/thumb`, hỏng thì lùi về
`/api/attachments/:id`; lightbox và ảnh trong dòng dùng bản xem. Tất cả
`loading="lazy"` — ảnh trong thẻ đang gập không tải cho tới khi mở.

### 4. Lỗi và ca biên

- Ảnh lưu không được: bước vẫn thành công, chỉ không có thumbnail.
- Thumbnail 404: lùi về bản xem; bản xem 404: ẩn thumbnail đó.
- `look_at` PDF: dòng "Read report.pdf", không ảnh.
- Thẻ có 0 ảnh: không có dải, không có popup.
- Nạp lại cuộc trò chuyện: dựng lại từ `result.shot` như mọi thứ khác.
- Chia sẻ: các bước này đã bị ẩn (`hidden: true`), ảnh không đi theo — có test ghim.

## Khác Claude có chủ đích

- **Lệnh thật vẫn hiện mờ cạnh tiêu đề của model** — review bảo mật 2026-10-13: tiêu
  đề là lời model, lệnh là sự thật; một tiêu đề "trấn an" không được che lệnh.
- **Đồng hồ chạy trên tiêu đề** — chủ dự án yêu cầu 2026-10-13.
- **✗ đỏ trên dòng lỗi**, ngoài "(1 failed)" trong tóm tắt.
- **Nền trắng sau ảnh** — sơ đồ trong suốt không biến mất trên nền tối.
- **Không có "finished a background command"** — app không có sự kiện tương ứng.

## Ngoài phạm vi

- Ảnh trong kết quả tool gửi thẳng cho model nhìn được (provider) — vẫn qua `see()`.
- Thumbnail cho trang PDF.
- `fs_read_text` (trình duyệt file trong giao diện) — không phải tool của model.
- Đổi kiểu các thẻ tool đơn lẻ khác.

## Kiểm thử

| Kiểm | Ở đâu |
|---|---|
| `read_file` trên ảnh trả ảnh thu nhỏ, không phải chữ rác; file chữ không đổi | `test/workspace.test.mjs` |
| `keepStepShot`: id có sẵn, ảnh đã đọc (giới hạn, tên, thumbnail), screenshot như cũ | `test/attachments.test.mjs` |
| `look_at` theo `path` / `url` / `file_id` trả `shot`; PDF không có; `path` vẫn là `safe` | `test/agent.test.mjs`, `test/features.test.mjs` |
| `read_file` ảnh → đọc bằng `see()`; `see()` hỏng → lỗi, ảnh vẫn còn | `test/agent.test.mjs` |
| Chia sẻ vẫn ẩn các bước này và ảnh của chúng | `test/isolation.test.mjs` |
| Dòng "Read <tên>", tóm tắt có "(1 failed)", chọn 3 ảnh + "+N" | `test/steps.test.mjs` |
| Khoá i18n vi/en đủ đôi | `test/i18n.test.mjs` |
| Dải thumbnail khi gập/ẩn khi mở, popup, lightbox: phím, focus, đếm | `test/ui.test.mjs` |
| Mô tả `look_at` dài thêm vẫn trong ngân sách; eval chọn `look_at` với `path` | `test/toolbudget.test.mjs`, `test/eval/cases.mjs` |
