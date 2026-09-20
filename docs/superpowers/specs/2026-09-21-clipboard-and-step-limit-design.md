# Copy sạch ra tài liệu, và một lượt chạy nói rõ vì sao nó dừng

Ngày: 2026-09-21

Ba triệu chứng người dùng báo, hai nguyên nhân gốc khác nhau:

1. Bôi đen câu trả lời rồi dán vào Google Docs thì ra **nền đen, chữ sáng, không sửa được** —
   cả một khối bảng đen giữa tài liệu trắng.
2. Câu trả lời của AI **không có nút copy**; chỉ tin nhắn của người dùng mới có.
3. Một lượt tự động hay **dừng giữa chừng**, không nói gì, phải gõ "continue" để chạy tiếp.

(1) và (2) là cùng một khoảng trống: app biết cách xuất HTML sạch cho Word, nhưng chỉ cho
file đính kèm, không cho tin nhắn. (3) là một cái trần có thật nhưng vô hình.

---

## Phần I — Nguyên nhân

### 1. Clipboard mang theo cả theme tối

Không có gì "hỏng". Bôi đen + Ctrl+C là trình duyệt tự dựng `text/html` từ vùng chọn, kèm
**style đã tính toán** của từng node. App vẽ transcript trên nền tối, nên HTML đó mang
`background` tối và `color` sáng. Google Docs tôn trọng style được dán, nên tài liệu nhận
đúng cái nó được đưa. Phần "không sửa được" là bảng markdown đã thành `<table>` có nền —
sửa chữ thì chữ sáng trên nền sáng, nhìn như mất.

App **đã có** lời giải: `forWord()` trong `public/js/viewer.js:637-643` dựng một tài liệu
HTML hoàn chỉnh, nền trắng chữ đen, có `<meta charset="utf-8">` — cái meta đó là thứ chống
mojibake tiếng Việt khi Word đoán encoding. Nhưng nó nằm trong closure của `createViewer()`,
chỉ dùng được cho file đang mở trong viewer.

### 2. Lượt assistant không có hành động nào

`public/js/render.js:711-720` gắn `msg__actions` (copy + edit) cho `.msg--user`.
`assistantMessage()` tại `render.js:731` không gắn gì. CSS cũng chỉ có
`.msg--user:hover .msg__actions` (`public/css/app.css:1987`).

### 3. Trần 30 bước, và lời giải thích biến mất sau 3 giây

`server/agent.js:1071` — `for (let step = 0; step < prefs.maxSteps; step += 1)`.
`server/settings.js:11` — `maxSteps: 30`. Hết vòng lặp:

```js
emit('status', { phase: 'step_limit', message: `Stopped after ${prefs.maxSteps} steps. …` });
emit('done', { stopReason: 'max_steps' });
```

Phía client, `public/js/app.js:2716` xử lý status không thuộc phase nào đã biết bằng
`toast(message)` — một toast tự xóa sau 3.2 giây. Còn handler `done` chỉ vẽ ghi chú khi có
`stop.message`, mà nhánh `max_steps` **không gửi** `stop`.

Kết quả: một phiên nghiên cứu dài đụng trần ở bước 30, dừng, và trong transcript không còn
dấu vết nào nói vì sao. Nhánh `token_limit` (`agent.js:1078-1085`) có đúng khuyết tật này.

Đây không phải lỗi hiếm: một câu hỏi nghiên cứu thật sự tiêu 15-25 lượt `web_search` +
`web_fetch`, cộng đọc file và viết tài liệu là chạm 30 thường xuyên.

---

## Phần II — Thiết kế

### A. `public/js/clipboard.js` — một chỗ duy nhất biết thế nào là "sạch"

Module mới, không phụ thuộc gì ngoài `markdown.js` (cho `escapeHtml`) và `i18n.js`.

| Hàm | Làm gì | Ai dùng |
|---|---|---|
| `forWord(html)` | Bọc fragment thành tài liệu HTML đủ `<meta charset>` + stylesheet nền trắng | viewer, transcript |
| `cleanHtml(node)` | Nhân bản subtree, gỡ chrome của app và mọi `class`/`style`/`data-*` | transcript |
| `writeRich({ html, text })` | Đặt đồng thời `text/html` và `text/plain`, có nhánh dự phòng | viewer, transcript |
| `legacyCopy(html, text)` | Đường lùi khi `navigator.clipboard.write` bị từ chối | `writeRich` |

`forWord`, `writeRich`, `legacyCopy` và bộ hằng `MONO/TABLE/CELL/HEAD` **chuyển nguyên trạng**
từ `viewer.js`; viewer import lại. Hành vi copy của viewer không đổi — đó là điều kiện để
biết việc tách module không làm hỏng gì.

`cleanHtml(node)` là phần mới, và nó là cả câu trả lời cho (1):

- Nhân bản (`cloneNode(true)`) để không đụng vào DOM đang hiển thị.
- Gỡ các node chỉ là giao diện: `.copy-btn` trong thanh code block, `.msg__actions`,
  `.step__shot` (thumbnail màn hình), mọi `<button>`.
- Gỡ `class`, `style`, và mọi `data-*` trên toàn bộ cây. Sau bước này không còn thuộc tính
  nào để Google Docs suy ra màu — nó chỉ thấy `<h2>`, `<table>`, `<strong>`, `<pre>`.
- Giữ `<a href>`: một đường dẫn nguồn là nội dung, không phải trang trí.

Thứ tự đúng là gỡ node trước, gỡ thuộc tính sau; ngược lại thì không còn `class` để tìm ra
node cần gỡ.

### B. Nút copy trên lượt assistant

`assistantMessage()` gắn một `msg__actions` chứa **một** nút copy, cùng icon và cùng lớp CSS
với nút của tin nhắn người dùng. CSS thêm `.msg--assistant:hover .msg__actions` và nhánh
`:focus-visible` tương ứng, căn trái thay vì phải.

Markdown gốc của lượt nằm ở biến `rawText` trong closure. Listener copy là một listener ủy
quyền duy nhất trên `#messages` (`app.js:2097`) nên nó cần đường lấy `rawText` từ node:

```js
// render.js
const RAW = new WeakMap();           // node lượt  →  markdown gốc
export const markdownOf = (node) => RAW.get(node) ?? '';
```

WeakMap chứ không phải `dataset`: một câu trả lời 20.000 ký tự nhân đôi vào một thuộc tính
DOM là tốn bộ nhớ thật, và WeakMap tự buông khi transcript bị dựng lại. `appendText` và
`resetText` cập nhật nó — `hydrate` đi qua `appendText` nên lượt tải lại từ DB cũng có.

Bấm nút:

```js
writeRich({
  html: forWord(cleanHtml(node.querySelector('.prose'))),
  text: markdownOf(node),
});
```

Dán vào Google Docs/Word ra định dạng sạch; dán vào editor hoặc ô chat ra markdown gốc.
Không có `.prose` (lượt chỉ có tool call) thì nút không được vẽ.

### C. Bôi đen + Ctrl+C

Một listener `copy` trên `#messages`:

1. Bỏ qua nếu `event.target` nằm trong `input`, `textarea` hoặc `[contenteditable]` — lúc
   sửa tin nhắn, copy là việc của trình duyệt.
2. Bỏ qua nếu vùng chọn rỗng hoặc nằm ngoài `#messages`.
3. `selection.getRangeAt(0).cloneContents()` → bọc vào một `div` → `cleanHtml` → `forWord`.
4. `event.preventDefault()` rồi `clipboardData.setData('text/html', …)` và
   `setData('text/plain', selection.toString())`.

Đây là đường người dùng đang thực sự dùng, nên nó là chỗ sửa quan trọng hơn cả nút bấm.

Một đánh đổi được chấp nhận có ý thức: vùng chọn cắt ngang giữa một `<table>` sẽ cho ra
fragment bảng thiếu đầu — đó là hành vi của `cloneContents`, giống hệt cái trình duyệt vốn
làm, và sửa nó nghĩa là tự viết lại logic vùng chọn. Không làm.

### D. Nói rõ vì sao nó dừng, và cho bấm tiếp

**Server** (`server/agent.js`) — cả hai nhánh trần:

```js
const stop = { kind: 'max_steps', message: '…', resumable: true };
emit('status', { phase: 'step_limit', message: stop.message });
emit('done', { stopReason: 'max_steps', stop });
```

`resumable: true` là thứ phân biệt "hết ngân sách bước" với "bị bộ lọc nội dung từ chối" —
cái đầu bấm tiếp được, cái sau thì không.

**Client** — `stopNote()` trong `render.js` nhận thêm một tham số hành động tùy chọn và vẽ
một nút trong ghi chú. Handler `done` ở `app.js` gọi `noteStop` cho mọi `stop.message` như
hiện nay; khi `stop.resumable` thì kèm nút **Tiếp tục**, bấm là gọi `stream()`.

`stream()` chạy tiếp được mà **không cần thêm tin nhắn nào**: route `POST /api/chats/:id/run`
(`server/app.js:1531`) dựng lượt từ transcript đã lưu, và bước cuối cùng đã lưu là một tool
result. Đây là lý do nút này đúng đắn hơn việc gõ "continue" — nó không nhét một tin nhắn
rác vào hội thoại, và không tốn token cho một từ vô nghĩa.

Ghi chú sống trong phiên đang mở, giống `stopNote` hiện tại — tải lại trang thì mất. Nhất
quán với hành vi sẵn có; lưu vào DB là một thay đổi schema không tương xứng với lợi ích.

**Mặc định**: `server/settings.js:11` đổi `maxSteps: 30` → `60`. Trần cứng 100 ở
`server/app.js:756` giữ nguyên.

Điểm thật thà phải nói trong bàn giao: prefs được lưu nguyên khối, nên **tài khoản đã tồn
tại vẫn giữ 30**. Chủ tài khoản phải vào Cài đặt → Hành vi → "Số bước công cụ tối đa mỗi
lượt" để nâng. Mặc định mới chỉ có tác dụng với tài khoản mới.

**i18n**: `stop.max_steps`, `stop.token_limit`, `chat.continue` — thêm vào cả `en.js` và
`vi.js`. `test/i18n.test.mjs` bắt lệch khóa tự động.

---

## Phần III — Kiểm thử

| Kiểm | Ở đâu |
|---|---|
| `forWord` giữ nguyên dấu tiếng Việt, có `charset=utf-8`, đặt nền trắng chữ đen | `test/clipboard.test.mjs` (mới, vào `npm test`) |
| Chạm trần bước → `done` mang `stop.kind === 'max_steps'` và `resumable` | `test/agent.test.mjs` |
| Khóa i18n vi/en không lệch | `test/i18n.test.mjs` (tự động) |
| `cleanHtml` gỡ hết `class`/`style`/`data-*`, gỡ `.copy-btn`, giữ `<table>`/`<h2>`/`<a href>` | `test/ui.test.mjs` (Chrome thật) |
| Lượt assistant có nút copy; bấm ghi được clipboard | `test/ui.test.mjs` |

Ranh giới này không tùy tiện. `test/lib` chỉ có `tmp.mjs` và `untranslated.mjs` — bộ test
nhanh **không có DOM**, và thêm jsdom vào một bộ chạy liên tục để kiểm một hàm vốn chỉ sống
trong trình duyệt là trả giá sai chỗ. Nên `forWord` (hàm chuỗi thuần) vào bộ nhanh, còn
`cleanHtml` (cần DOM thật) vào `test/ui.test.mjs`.

Hệ quả phải nhớ: `npm run check` **không** chạy `test:ui`. Trước khi gọi việc này là xong,
phải chạy thêm `npm run test:ui` và đọc kết quả — không được suy đoán.

---

## Ngoài phạm vi

- **Không** tự động chạy tiếp khi chạm trần. Một điểm dừng để người dùng nhìn và quyết định
  là thứ có giá trị; tự resume là cách tiêu token âm thầm.
- **Không** lưu ghi chú dừng vào DB.
- **Không** đụng vào nút copy của code block — nó đã đúng.
- **Không** thêm nút edit cho lượt assistant.
