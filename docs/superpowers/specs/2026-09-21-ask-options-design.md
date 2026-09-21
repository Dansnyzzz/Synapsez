# Hỏi bằng lựa chọn bấm được, thay vì bắt người dùng gõ lại

Ngày: 2026-09-21

## Vấn đề

Khi trợ lý cần biết thêm một thông tin để làm đúng việc — "bạn quan tâm lĩnh vực
nào?", "bài đọc dài cỡ nào là vừa?" — nó chỉ có một cách hỏi: viết câu hỏi ra
văn bản rồi dừng lượt. Người dùng phải đọc, tự gõ câu trả lời, và thường gõ một
thứ mà model phải đoán lại ý.

Hệ quả thực tế: hoặc trợ lý **không hỏi** và đoán bừa, hoặc nó hỏi và người dùng
phải làm việc gõ. Cả hai đều kém hơn một danh sách bấm được.

## Quyết định đã chốt với chủ dự án

Đây là **một tool trong danh mục** (`ask_options`), không phải cú pháp markdown
đặc biệt trong câu trả lời. Model tự quyết định khi nào cần hỏi và tự soạn các
lựa chọn cho vừa nội dung. Lượt chạy **dừng lại chờ**, người dùng chọn xong thì
chạy tiếp từ đúng chỗ đó.

## Vì sao không tái dụng nguyên xi cơ chế approval

Ý định ban đầu là dùng lại đường approval đã có. Đọc code thì không được, và lý
do đáng ghi lại:

`needsApproval` ở `server/agent.js:563` trả về mảng rỗng khi chính sách là
`auto`, `readonly` hoặc `plan`. Chủ dự án chạy ở **Tự chạy** (`auto`). Nếu gắn
câu hỏi vào đường đó thì đúng ở chế độ mà người dùng đang dùng, câu hỏi sẽ bị
**bỏ qua hoàn toàn** — sai nghiêm trọng, vì hỏi người dùng không phải một cổng
kiểm soát rủi ro, nó là mục đích của tool.

Approval hỏi "việc này có được phép chạy không". `ask_options` hỏi "bạn muốn thế
nào". Hai câu hỏi khác nhau, phải là hai đường khác nhau.

Cái **được** tái dụng là *hình dạng* của đường approval — dừng sau khi đã lưu
lượt, rồi resume bằng một lần gọi lại cùng route — vì phần đó đã đúng và đã
được thử lửa: lượt assistant được ghi vào DB ở `agent.js:1317` **trước** khi
dừng, nên resume không mất gì.

## Thiết kế

### Tool

```js
ask_options({
  questions: [
    {
      question: 'Bạn muốn ưu tiên những lĩnh vực nào?',
      options: ['AI, LLM và nghiên cứu', 'Tài chính và đầu tư', ...],
      multiple: true,    // mặc định false
      other: true,       // mặc định true — cho phép tự gõ thêm
      other_label: 'Thêm lĩnh vực bạn quan tâm',
    },
  ],
})
```

- 1–5 câu hỏi trong **một** lần gọi. Nhiều câu một lần là có chủ đích: mỗi lần
  dừng-rồi-chạy-tiếp tốn một vòng gọi model, nên hỏi ba thứ trong một thẻ rẻ hơn
  ba lần hỏi gấp ba lần.
- 2–8 lựa chọn mỗi câu.
- `readOnly: true` → `assessRisk` cho ra `safe` → **không** kèm thêm một hộp
  approval chồng lên câu hỏi.

Kết quả tool trả về cho model là câu văn xuôi, không phải JSON: model đọc văn
bản tốt hơn đọc cấu trúc, và kết quả tool vốn là văn bản.

### Dừng và chạy tiếp

1. Model gọi `ask_options`.
2. Vòng lặp, **trước khi chạy bất kỳ tool nào trong lô**, thấy có
   `ask_options` mà chưa có câu trả lời → phát `question_required` kèm nội dung
   câu hỏi, rồi `return`. Lượt đã được lưu.
3. Trình duyệt vẽ thẻ. Người dùng chọn / tự gõ / bỏ qua.
4. Trình duyệt gọi lại `POST /api/chats/:id/run` kèm `answers`.
5. Vòng lặp vào nhánh resume, dựng kết quả cho `ask_options` từ `answers`, chạy
   nốt các tool còn lại trong lô, rồi đi tiếp bình thường.

Gọi kèm tool khác trong cùng lô vẫn chạy đúng, nhưng mô tả tool khuyên gọi một
mình — trả lời một câu hỏi rồi mới hành động là thứ tự đúng.

### Giao diện

Một thẻ dưới transcript, cùng chỗ hộp approval đang đứng:

- Câu hỏi, và `1 / 3` kèm hai mũi tên khi có nhiều câu.
- Lựa chọn: ô tròn cho chọn một, ô vuông cho chọn nhiều.
- Ô nhập tự do ở dưới, khi `other` bật.
- **Bỏ qua** khi chưa chọn gì, **Tiếp** khi đã chọn, **Xong** ở câu cuối.
- Dấu ✕ bỏ qua toàn bộ.

Bỏ qua là một câu trả lời thật, không phải huỷ: kết quả tool nói rõ người dùng
đã bỏ qua và dặn model tự quyết, đừng hỏi lại. Một trợ lý hỏi lại đúng câu vừa
bị bỏ qua là thứ khiến người ta ngừng dùng.

### Báo khi người dùng không ngồi trước màn hình

Dùng Notification API của trình duyệt, **không** dùng tool `notify`: `notify` có
phạm vi `local`, cần máy tính đã ghép nối đang bật, nên trên điện thoại là vô
dụng — mà điện thoại chính là lúc người ta rời màn hình.

Chỉ báo khi `document.hidden`. Xin quyền **ngay lúc đó**, không xin lúc tải
trang: xin quyền thông báo khi vừa mở trang là mẫu hành vi tối và trình duyệt
phạt điểm trang làm thế.

## Ngoài phạm vi

- **Không** lưu thẻ câu hỏi vào DB như một loại tin nhắn riêng. Nó là một tool
  call đang chờ, và tool call đã được lưu rồi.
- **Không** để model hỏi lại sau khi bị bỏ qua — nói trong kết quả tool, không
  ép bằng code.
- **Không** có thanh tiến trình hay hoạt ảnh chuyển câu.

## Kiểm thử

| Kiểm | Ở đâu |
|---|---|
| Chuẩn hoá tham số: cắt số câu, số lựa chọn, bỏ câu rỗng | `test/agent.test.mjs` |
| Kết quả tool đọc thành câu, cả khi chọn nhiều / tự gõ / bỏ qua | `test/agent.test.mjs` |
| `ask_options` là `safe` nên không kéo theo hộp approval | `test/agent.test.mjs` |
| Vòng lặp dừng ở `ask_options` **kể cả** khi chính sách là `auto` | `test/agent.test.mjs` |
| Khoá i18n vi/en đủ đôi | `test/i18n.test.mjs` |
| Thẻ vẽ ra, chọn được, phân trang, trả lời quay về | `test/ui.test.mjs` |
