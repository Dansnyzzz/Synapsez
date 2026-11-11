/**
 * Tiếng Việt cho những câu do server tự viết.
 *
 * Khoá là "hình dạng" của câu tiếng Anh đúng như trong mã nguồn, với `{0}`,
 * `{1}` … ở chỗ mã chèn một giá trị. `scripts/server-messages.js` đọc các hình
 * dạng đó ra từ mã, và `test/i18n.test.mjs` báo lỗi khi một câu chưa có bản
 * dịch ở đây — nên sửa câu tiếng Anh thì phải sửa khoá tương ứng.
 *
 * Giữ nguyên tên biến môi trường, tên công cụ, định dạng và đường dẫn: đó là thứ
 * người dùng phải gõ hoặc tìm thấy đúng như vậy.
 */
export const vi = {
  /* ── hội thoại & lượt chạy ─────────────────────────────────────── */
  'Chat not found.': 'Không tìm thấy cuộc trò chuyện.',
  'Now available to the assistant: {0}.': 'Trợ lý giờ đã dùng được: {0}.',
  'Chat not found': 'Không tìm thấy cuộc trò chuyện',
  '{0} has been shut down by its provider, so this is using {1} instead.':
    '{0} đã bị nhà cung cấp ngừng hoạt động, nên đang dùng {1} thay thế.',
  'Stopped after {0} tokens in this turn. Send a message to continue.':
    'Đã dừng sau {0} token trong lượt này. Gửi một tin nhắn để tiếp tục.',
  'Stopped after {0} steps. Send a message to continue.': 'Đã dừng sau {0} bước. Gửi một tin nhắn để tiếp tục.',

  /* ── hỏi người dùng bằng nút bấm ── */
  'ask_options needs at least one question with two or more distinct options. Pass questions: [{ question, options: ["…", "…"] }].':
    'ask_options cần ít nhất một câu hỏi kèm từ hai lựa chọn khác nhau trở lên. Hãy truyền questions: [{ question, options: ["…", "…"] }].',
  'ask_options ran without the user having answered, which should not happen. Do not retry it; ask in prose instead.':
    'ask_options chạy khi người dùng chưa trả lời, đây là chuyện không nên xảy ra. Đừng thử lại; hãy hỏi bằng lời thường.',

  /* ── reading a video ── */
  '"{0}" is not a YouTube video. Pass a watch, share, Shorts or embed link, or the 11-character video id.':
    '"{0}" không phải video YouTube. Hãy đưa link watch, link chia sẻ, link Shorts hoặc link nhúng, hoặc mã video 11 ký tự.',
  'supadata.ai → sign up → Dashboard → API key. The free plan is 100 transcripts a month and takes no card. Only needed to read videos; everything else works without it.':
    'supadata.ai → đăng ký → Dashboard → API key. Gói miễn phí được 100 phụ đề mỗi tháng và không cần thẻ. Chỉ cần cho việc đọc video; mọi thứ khác vẫn chạy mà không có nó.',
  'Supadata rejected that key (HTTP {0}).': 'Supadata từ chối key đó (HTTP {0}).',

  'This task is already running. Wait for it to finish.': 'Tác vụ này đang chạy. Hãy đợi nó xong.',

  /* ── tần suất chạy ── */
  'Give a date and a time for a one-off run.': 'Hãy chọn ngày và giờ cho lần chạy một lần.',
  'That time has already passed — pick one in the future.': 'Thời điểm đó đã qua — hãy chọn một thời điểm trong tương lai.',
  'That schedule has no valid starting time.': 'Lịch này không có thời điểm bắt đầu hợp lệ.',
  'Every {0} minutes is the shortest repeat — a shorter one cannot be kept to.':
    'Ngắn nhất là mỗi {0} phút — khoảng ngắn hơn không thể giữ đúng giờ.',
  'The number of minutes must be a whole number from {0} to {1}.': 'Số phút phải là số nguyên từ {0} đến {1}.',
  'The number of hours must be a whole number from {0} to {1}.': 'Số giờ phải là số nguyên từ {0} đến {1}.',
  'The number of days must be a whole number from {0} to {1}.': 'Số ngày phải là số nguyên từ {0} đến {1}.',
  'The minute must be a whole number from 0 to 59.': 'Phút phải là số nguyên từ 0 đến 59.',
  'Could not find a time matching "{0}".': 'Không tìm được thời điểm nào khớp với "{0}".',
  'An interval that does not divide the day needs a starting time.': 'Khoảng lặp không chia hết một ngày thì cần một thời điểm bắt đầu.',
  'Give the first day as YYYY-MM-DD.': 'Hãy nhập ngày bắt đầu dạng YYYY-MM-DD.',
  'Pick at least one day of the week.': 'Hãy chọn ít nhất một thứ trong tuần.',
  'Give at least one time as HH:MM — "07:00".': 'Hãy nhập ít nhất một giờ dạng HH:MM — "07:00".',
  'Pick at least one day of the month.': 'Hãy chọn ít nhất một ngày trong tháng.',

  /* ── tìm bản tin RSS thật của một trang ── */
  [`{0} led to a web page, not an RSS or Atom feed. The feeds {1} lists are:
{2}
Call read_feed with the one you want.`]: `{0} dẫn tới một trang web, không phải bản tin RSS hay Atom. Các bản tin {1} có là:
{2}
Hãy gọi read_feed với bản tin bạn muốn.`,
  [`{0} returned HTTP {1}. The feeds {2} lists are:
{3}
Call read_feed with the one you want.`]: `{0} trả về HTTP {1}. Các bản tin {2} có là:
{3}
Hãy gọi read_feed với bản tin bạn muốn.`,
  '{0} led to a web page, not a feed, and {1} lists no feeds. Use web_search or web_fetch for this site instead.':
    '{0} dẫn tới một trang web, không phải bản tin, và {1} không liệt kê bản tin nào. Hãy dùng web_search hoặc web_fetch cho trang này.',
  '{0} returned HTTP {1}, and {2} lists no feeds. Use web_search or web_fetch for this site instead.':
    '{0} trả về HTTP {1}, và {2} không liệt kê bản tin nào. Hãy dùng web_search hoặc web_fetch cho trang này.',

  /* ── dữ liệu rời khỏi tài khoản ── */
  'The address carries a long block of data to {0}. Check it is not your information leaving — a page or email can ask for exactly this.':
    'Địa chỉ này mang theo một khối dữ liệu dài gửi tới {0}. Hãy kiểm tra đó không phải thông tin của bạn đang bị gửi ra ngoài — một trang web hay email có thể yêu cầu đúng việc này.',
  '"{0}" is not an email id — use the id from a Gmail search.':
    '"{0}" không phải mã email — hãy dùng mã lấy từ một lần tìm kiếm Gmail.',
  'Supadata could not read that video: {0}': 'Supadata không đọc được video đó: {0}',
  'Supadata queued video {0} as a background job rather than answering, which this tool cannot wait for. Try a shorter video.':
    'Supadata xếp video {0} vào hàng đợi xử lý nền thay vì trả lời ngay, và công cụ này không chờ được. Hãy thử video ngắn hơn.',
  'Supadata returned no captions for video {0}. The video probably has none — say so rather than retrying.':
    'Supadata không trả về phụ đề nào cho video {0}. Nhiều khả năng video không có phụ đề — hãy nói thẳng ra thay vì thử lại.',
  'This conversation is already running somewhere else. Wait for it, or stop it there.':
    'Cuộc trò chuyện này đang chạy ở nơi khác. Hãy đợi, hoặc dừng nó ở đó.',
  'Type something, or attach a file.': 'Hãy gõ gì đó, hoặc đính kèm một tệp.',
  'This conversation is running. Stop it first.': 'Cuộc trò chuyện này đang chạy. Hãy dừng nó trước.',
  /* Câu cũ chỉ nói "hãy dừng nó trước" mà không nói dừng ở đâu — và giờ lượt
     chạy sống sót qua cả refresh, nên người dùng gặp câu này đúng lúc trang vừa
     mở lại và dễ tưởng là hỏng. */
  'This conversation is still answering, so it cannot be rewritten underneath itself. Press Stop above the composer, then try again.':
    'Cuộc trò chuyện này vẫn đang trả lời, nên không thể sửa nội dung ngay bên dưới nó. Hãy bấm Dừng ở phía trên ô nhập rồi thử lại.',
  'No such note.': 'Không có ghi chú này.',
  'There is no earlier version of this note.': 'Ghi chú này không có phiên bản trước để quay lại.',
  'A message cannot be empty.': 'Tin nhắn không được để trống.',
  'Message not found': 'Không tìm thấy tin nhắn',
  'There is not enough here yet to be worth folding up.': 'Chưa đủ nội dung để đáng gộp lại.',
  'Only your own messages can be edited.': 'Chỉ sửa được tin nhắn của chính bạn.',
  'Cancelled by the user.': 'Người dùng đã huỷ.',
  'Timed out.': 'Hết thời gian chờ.',
  "Auto uses OpenRouter's free router, so it needs an OpenRouter key. Add one in Settings → Providers, or pick a specific model.":
    'Auto dùng bộ định tuyến miễn phí của OpenRouter, nên cần một key OpenRouter. Thêm key trong Cài đặt → Nhà cung cấp, hoặc chọn một model cụ thể.',
  '{0} — pick another model from the picker.': '{0} — hãy chọn model khác trong bộ chọn model.',
  'The model this account uses': 'Model tài khoản này đang dùng',
  '{0} is no longer available — whoever was serving it withdrew it, and nothing you did caused this. Its provider names "{1}" as the replacement. Pick another model from the chip in the header.':
    '{0} không còn được cung cấp nữa — bên phục vụ model đã ngừng nó, và đây không phải lỗi của bạn. Nhà cung cấp chỉ định "{1}" là bản thay thế. Hãy chọn model khác ở chip trên thanh đầu trang.',
  '{0} is no longer available — whoever was serving it withdrew it, and nothing you did caused this. Pick another model from the chip in the header.':
    '{0} không còn được cung cấp nữa — bên phục vụ model đã ngừng nó, và đây không phải lỗi của bạn. Hãy chọn model khác ở chip trên thanh đầu trang.',

  /* ── chung ─────────────────────────────────────────────────────── */
  'workerId is required': 'Thiếu workerId',
  'No such job.': 'Không có tác vụ này.',
  'Name cannot be empty.': 'Tên không được để trống.',
  'Not found': 'Không tìm thấy',
  'Not available': 'Không có sẵn',
  'the template is not there': 'không tìm thấy mẫu máy',
  'This sends one of your personal details — hidden from the model as a placeholder — out of this app. Check where it is going before it runs.':
    'Thao tác này gửi một thông tin cá nhân của bạn (đang được che khỏi mô hình bằng mã giữ chỗ) ra khỏi ứng dụng. Hãy kiểm tra nơi nhận trước khi chạy.',
  'A file from Google Drive stays off the cloud computer, so LibreOffice cannot draw it. The ordinary preview still works.':
    'Tệp từ Google Drive không được đưa lên máy tính đám mây, nên LibreOffice không vẽ được. Bản xem trước thông thường vẫn dùng được.',
  'That file unpacks to more than can be changed here.': 'Tệp này giải nén ra quá lớn để sửa ở đây.',
  'A formula that reaches out to the internet or another program cannot be added here.': 'Không thể thêm công thức gọi ra Internet hoặc chương trình khác ở đây.',
  'Say how big the file is.': 'Hãy cho biết dung lượng tệp.',
  'That file is over the 2 GB limit for one file.': 'Tệp này vượt giới hạn 2 GB cho mỗi tệp.',
  'This cloud computer cannot take a file sent straight to it.': 'Máy tính đám mây này không nhận được tệp gửi thẳng.',
  'That is not where an upload goes.': 'Đó không phải nơi nhận tệp tải lên.',
  'That file did not reach the cloud computer. Try sending it again.': 'Tệp chưa tới được máy tính đám mây. Hãy thử gửi lại.',
  '{0} is an unannounced preview and nothing says what it keeps, so it was not sent this. Provider privacy is Strict, or the conversation holds data from your Google account. Pick another model.':
    '{0} là bản xem trước giấu tên và không có gì cho biết nó lưu những gì, nên nội dung này không được gửi tới đó. Quyền riêng tư nhà cung cấp đang ở mức Nghiêm ngặt, hoặc cuộc trò chuyện có dữ liệu từ tài khoản Google của bạn. Hãy chọn model khác.',
  'The independent check could not finish, so this is being asked rather than assumed safe.':
    'Bước kiểm tra độc lập không hoàn tất được, nên hành động này được hỏi bạn thay vì mặc định là an toàn.',
  'An independent check questioned this: {0}': 'Một bước kiểm tra độc lập thấy đáng ngờ: {0}',
  'Admins only.': 'Chỉ dành cho quản trị viên.',
  'CRON_SECRET is not configured.': 'Chưa cấu hình CRON_SECRET.',
  'Which file?': 'Tệp nào?',
  'Move what, and where to?': 'Di chuyển cái gì, và tới đâu?',
  'Search for what?': 'Tìm gì?',
  'Give something to search for.': 'Hãy nhập thứ cần tìm.',
  'Too many attempts. Try again in about {0} minute{1}.': 'Thử quá nhiều lần. Hãy thử lại sau khoảng {0} phút.',
  'Unknown role "{0}".': 'Vai trò "{0}" không hợp lệ.',
  '"{0}" is not a language this interface has. Use one of: {1}.':
    '"{0}" không phải ngôn ngữ giao diện này có. Dùng một trong: {1}.',
  '"{0}" is not a timezone this system recognises.': '"{0}" không phải múi giờ hệ thống nhận ra.',

  /* ── sandbox, dự án, kỹ năng, tác vụ ───────────────────────────── */
  'Driving the sandbox by hand needs the server on the same machine as the browser.':
    'Điều khiển sandbox bằng tay cần máy chủ chạy trên cùng máy với trình duyệt.',

  /* ── trình duyệt & máy tính đám mây ── */
  'Closed the cloud browser. Its sign-ins are kept for next time.':
    'Đã đóng trình duyệt đám mây. Các phiên đăng nhập được giữ lại cho lần sau.',
  'The cloud browser did not come up in time.{0}': 'Trình duyệt đám mây không khởi động kịp.{0}',
  'Unknown action "{0}". One of: {1}.': 'Không có thao tác "{0}". Chọn một trong: {1}.',
  "The cloud computer's helper started but did not answer. Try once more.":
    'Trình trợ giúp trên máy tính đám mây đã khởi động nhưng không phản hồi. Hãy thử lại một lần nữa.',
  "The cloud computer's helper stopped as it started.{0}": 'Trình trợ giúp trên máy tính đám mây dừng ngay khi vừa khởi động.{0}',
  "The cloud computer's helper stopped as it started (exit code {0}).{1}":
    'Trình trợ giúp trên máy tính đám mây dừng ngay khi vừa khởi động (mã thoát {0}).{1}',
  "The cloud computer's helper was stopped from outside as it started (exit code {0}).{1}":
    'Trình trợ giúp trên máy tính đám mây bị dừng từ bên ngoài ngay khi vừa khởi động (mã thoát {0}).{1}',
  'Something went wrong on the server. Try again in a moment.':
    'Máy chủ gặp lỗi. Thử lại sau ít phút.',
  'That is too large to send in one request.': 'Nội dung đó quá lớn để gửi trong một yêu cầu.',
  'That request could not be read.': 'Không đọc được yêu cầu đó.',
  '{0}\nLook again before the next step.':
    '{0}\nHãy xem lại trang trước bước tiếp theo.',
  '{0} is too large to read here ({1} MB; the most is {2} MB).':
    '{0} quá lớn để đọc ở đây ({1} MB; tối đa {2} MB).',
  "This conversation holds data from the person's Google account, and a skill is offered in every later conversation, whichever model runs it — so it is not written from here. Tell the user; they can write the skill in a new conversation.":
    'Cuộc trò chuyện này có dữ liệu từ tài khoản Google của người dùng, mà một kỹ năng sẽ được đưa vào mọi cuộc trò chuyện sau, dù model nào chạy — nên không tạo kỹ năng từ đây. Hãy nói với người dùng; họ có thể tạo kỹ năng trong một cuộc trò chuyện mới.',
  'That is not something the screen can do.': 'Màn hình không làm được thao tác đó.',
  'The cloud browser is resting. Ask the assistant to open a page and it will start again.':
    'Trình duyệt đám mây đang nghỉ. Hãy nhờ trợ lý mở một trang, nó sẽ khởi động lại.',
  'This account has used its {0} cloud-computer actions for today; it opens again in about {1}h. Tell the user plainly, and offer what can be done without it.':
    'Tài khoản này đã dùng hết {0} lượt máy tính đám mây của hôm nay; khoảng {1} giờ nữa sẽ mở lại. Hãy nói rõ với người dùng và đề xuất cách làm không cần nó.',
  "The cloud computers are at today's limit for the whole app; they open again in about {0}h. Tell the user plainly, and offer what can be done without it.":
    'Máy tính đám mây đã chạm giới hạn hôm nay của toàn ứng dụng; khoảng {0} giờ nữa sẽ mở lại. Hãy nói rõ với người dùng và đề xuất cách làm không cần nó.',
  'Every cloud computer this app may run at once is in use by other people right now. Try again in a few minutes; tell the user it is busy, not broken.':
    'Tất cả máy tính đám mây mà ứng dụng được chạy cùng lúc đang được người khác dùng. Hãy thử lại sau vài phút; nói với người dùng là đang bận, không phải bị hỏng.',
  "The cloud computers have used this month's free allotment, so none can start until it resets. Tell the user plainly, and offer what can be done without it.":
    'Máy tính đám mây đã dùng hết hạn mức miễn phí của tháng này, nên không máy nào khởi động được cho tới khi hạn mức được làm mới. Hãy nói rõ với người dùng và đề xuất cách làm không cần nó.',
  'A project needs a name.': 'Dự án cần có tên.',
  'No such project.': 'Không có dự án này.',
  'Skill not found': 'Không tìm thấy kỹ năng',
  'Say what the task should do.': 'Hãy nói tác vụ cần làm gì.',
  'Task not found': 'Không tìm thấy tác vụ',
  'This project has as much source text as it can hold. Remove something first.':
    'Dự án này đã chứa tối đa lượng văn bản nguồn. Hãy xoá bớt trước.',
  'A skill needs a name.': 'Kỹ năng cần có tên.',
  'Keep the name under {0} characters.': 'Tên phải dưới {0} ký tự.',
  'A skill needs a description — it is how the assistant decides when this applies, so say what it is for.':
    'Kỹ năng cần có mô tả — trợ lý dựa vào đó để quyết định khi nào áp dụng, nên hãy nói nó dùng để làm gì.',
  'Keep the description under {0} characters.': 'Mô tả phải dưới {0} ký tự.',
  /* kỹ năng mang tệp, tải kỹ năng lên, bản nháp (2026-11-01) */
  "A skill's files must be a list.": 'Các tệp của kỹ năng phải là một danh sách.',
  'A skill carries at most {0} files.': 'Một kỹ năng chỉ mang tối đa {0} tệp.',
  '"{0}" is not a file name a skill can carry.': '"{0}" không phải tên tệp mà kỹ năng mang theo được.',
  'Two files are called "{0}".': 'Có hai tệp cùng tên "{0}".',
  '{0} is too long for a skill to carry; keep each file under 20,000 characters.':
    '{0} quá dài để kỹ năng mang theo; mỗi tệp phải dưới 20.000 ký tự.',
  "A skill's files come to too much text together; keep what it carries short.":
    'Các tệp của kỹ năng cộng lại quá nhiều chữ; hãy giữ phần mang theo thật ngắn.',
  'That file is empty.': 'Tệp đó trống.',
  'That file is over 2 MB — too large for a skill.': 'Tệp đó lớn hơn 2 MB — quá lớn cho một kỹ năng.',
  'That archive could not be opened. A .zip or .skill holds a SKILL.md.':
    'Không mở được tệp nén đó. Tệp .zip hoặc .skill phải chứa một SKILL.md.',
  'There is no SKILL.md in that archive.': 'Tệp nén đó không có SKILL.md.',
  'That SKILL.md is too large for a skill.': 'SKILL.md đó quá lớn cho một kỹ năng.',
  'No Google product called "{0}".': 'Không có sản phẩm Google nào tên "{0}".',
  'Say what code or documentation to find — a library and what it should do, or an error message.':
    'Hãy nói cần tìm mã hay tài liệu gì — một thư viện và việc nó cần làm, hoặc một thông báo lỗi.',
  'Upload a .md file, or a .zip or .skill holding a SKILL.md.': 'Hãy tải lên tệp .md, hoặc tệp .zip hay .skill chứa SKILL.md.',
  'The SKILL.md has no description in its front matter (description: …).':
    'SKILL.md không có mô tả trong phần đầu (description: …).',
  'The SKILL.md has no instructions under its front matter.': 'SKILL.md không có hướng dẫn bên dưới phần đầu.',
  'Choose a skill file to upload.': 'Hãy chọn một tệp kỹ năng để tải lên.',
  'That draft is too long to keep.': 'Bản nháp đó quá dài để giữ lại.',
  '{0} holds what looks like a key, token or password. Take it out, then upload again.':
    '{0} chứa thứ trông như khoá, token hoặc mật khẩu. Hãy bỏ nó ra rồi tải lên lại.',
  '{0} has invisible characters, which can hide instructions. Remove them, then upload again.':
    '{0} có ký tự vô hình, thứ có thể giấu chỉ dẫn. Hãy xoá chúng rồi tải lên lại.',
  '{0} holds what looks like a key, token or password. Take it out, then share it again.':
    '{0} chứa thứ trông như khoá, token hoặc mật khẩu. Hãy bỏ nó ra rồi chia sẻ lại.',
  '{0} has invisible characters, which can hide instructions. Remove them, then share it again.':
    '{0} có ký tự vô hình, thứ có thể giấu chỉ dẫn. Hãy xoá chúng rồi chia sẻ lại.',
  "A shared skill is followed by other people's assistants, and the safety scan found something in this one they should not be given. Change it, or stop sharing it.":
    'Kỹ năng được chia sẻ sẽ được trợ lý của người khác làm theo, và bản quét an toàn đã tìm thấy trong kỹ năng này thứ không nên đưa cho họ. Hãy sửa lại, hoặc ngừng chia sẻ.',
  'That skill changed while it was being shared. Try again.': 'Kỹ năng đó vừa thay đổi trong lúc đang được chia sẻ. Hãy thử lại.',
  'That skill is not shared any more.': 'Kỹ năng đó không còn được chia sẻ nữa.',
  'That skill is yours already.': 'Kỹ năng đó vốn đã là của bạn.',
  'You have added {0} shared skills, as many as one account can. Remove one to add another.':
    'Bạn đã thêm {0} kỹ năng được chia sẻ, mức tối đa cho một tài khoản. Hãy gỡ một kỹ năng để thêm kỹ năng khác.',
  'That skill is not one you added.': 'Kỹ năng đó không nằm trong số kỹ năng bạn đã thêm.',
  'Say what to change: enabled or shared.': 'Hãy nói cần đổi gì: enabled hoặc shared.',
  'Say whether to hide it: hidden true or false.': 'Hãy nói có ẩn hay không: hidden là true hoặc false.',
  'No shared skill has that id.': 'Không có kỹ năng được chia sẻ nào có id đó.',
  '{0} tells the assistant to set aside its other instructions.': '{0} bảo trợ lý gác lại các chỉ dẫn khác của nó.',
  '{0} tells the assistant to send something to {1}.': '{0} bảo trợ lý gửi thứ gì đó tới {1}.',
  'Scripts are kept as text and never run here: {0}.': 'Script được giữ dưới dạng chữ và không bao giờ chạy ở đây: {0}.',
  'Left out {0}: only text files are kept with a skill.': 'Bỏ qua {0}: kỹ năng chỉ giữ tệp chữ.',
  'Left out {0}: over 20,000 characters.': 'Bỏ qua {0}: dài hơn 20.000 ký tự.',
  'Left out {0}: a skill carries at most {1} files.': 'Bỏ qua {0}: một kỹ năng chỉ mang tối đa {1} tệp.',
  'A skill needs instructions — the actual procedure.': 'Kỹ năng cần có hướng dẫn — tức là quy trình thực tế.',
  'That is too long for one skill; split it up.': 'Quá dài cho một kỹ năng; hãy tách ra.',
  'No skill called "{0}". Available: {1}': 'Không có kỹ năng nào tên "{0}". Hiện có: {1}',
  'Give a time as HH:MM, optionally with a weekday first — "17:00" or "fri 17:00".':
    'Nhập giờ dạng HH:MM, có thể thêm thứ ở đầu — "17:00" hoặc "fri 17:00".',
  '"{0}" is not a weekday. Use mon, tue, wed, thu, fri, sat or sun.':
    '"{0}" không phải thứ trong tuần. Dùng mon, tue, wed, thu, fri, sat hoặc sun.',
  'Could not find a time matching "{0}" in {1}.': 'Không tìm được thời điểm khớp "{0}" trong {1}.',
  '"{0}" is not a frequency. Pick one of: {1}.': '"{0}" không phải tần suất hợp lệ. Chọn một trong: {1}.',
  'An hourly repeat needs a minute from 0 to 59.': 'Lặp hằng giờ cần số phút từ 0 đến 59.',
  'Give the time as HH:MM — "07:00".': 'Nhập giờ dạng HH:MM — "07:00".',
  'A weekly repeat needs a weekday: mon, tue, wed, thu, fri, sat or sun.':
    'Lặp hằng tuần cần chọn thứ: mon, tue, wed, thu, fri, sat hoặc sun.',
  'A monthly repeat needs a day from 1 to 31.': 'Lặp hằng tháng cần ngày từ 1 đến 31.',
  'Give the end date as YYYY-MM-DD.': 'Nhập ngày kết thúc dạng YYYY-MM-DD.',
  'That end date is before the next run — pick a later one.':
    'Ngày kết thúc đó trước lần chạy tới — hãy chọn ngày muộn hơn.',
  'A monthly task needs a time as HH:MM — "monthly 1 08:00".':
    'Việc chạy hằng tháng cần giờ dạng HH:MM — "monthly 1 08:00".',
  'A weekdays task needs a time as HH:MM — "weekdays 08:00".':
    'Việc chạy các ngày trong tuần cần giờ dạng HH:MM — "weekdays 08:00".',
  'Could not find a day {0} in the next year.': 'Không tìm được ngày {0} trong vòng một năm tới.',

  /* ── tài khoản & đăng nhập ─────────────────────────────────────── */
  'Wrong email or password.': 'Sai email hoặc mật khẩu.',
  // Usernames (server/auth.js, 2026-10-20).
  'Wrong email/username or password.': 'Sai email/tên đăng nhập hoặc mật khẩu.',
  'A username is 3–24 letters, digits, dots or underscores, starting with a letter.':
    'Tên đăng nhập gồm 3–24 chữ cái, chữ số, dấu chấm hoặc gạch dưới, bắt đầu bằng một chữ cái.',
  'That username is reserved. Pick another.': 'Tên đăng nhập này đã được dành riêng. Hãy chọn tên khác.',
  'That username is taken.': 'Tên đăng nhập này đã có người dùng.',
  'You cannot suspend or demote yourself.': 'Bạn không thể tự khoá hoặc tự hạ quyền của mình.',
  'No such account.': 'Không có tài khoản này.',
  'You cannot delete your own account.': 'Bạn không thể xoá tài khoản của chính mình.',
  'Set SESSION_SECRET — refusing to issue sessions without one.':
    'Hãy đặt SESSION_SECRET — máy chủ từ chối tạo phiên đăng nhập khi thiếu nó.',
  'This puts one of your personal details — hidden from the model as a placeholder — into a web address. Check the address before it is sent.':
    'Lệnh này đưa một thông tin cá nhân của bạn — vốn được che với mô hình bằng mã giữ chỗ — vào một địa chỉ web. Hãy kiểm tra địa chỉ trước khi gửi.',
  'Set SESSION_SECRET — refusing to sign a Google sign-in without one.':
    'Hãy đặt SESSION_SECRET — máy chủ từ chối ký lượt đăng nhập Google khi thiếu nó.',
  'Use a password of at least 10 characters.': 'Hãy dùng mật khẩu ít nhất 10 ký tự.',
  'Confirm your email first: enter the 6-digit code we sent to it.':
    'Hãy xác nhận email trước: nhập mã 6 số chúng tôi đã gửi tới email đó.',
  'That code is not right, or it has expired. Ask for a new one.':
    'Mã không đúng hoặc đã hết hạn. Hãy yêu cầu mã mới.',
  'resolvers unreachable':
    'không hỏi được máy chủ DNS',
  'PUBLIC_URL is not set':
    'Chưa đặt PUBLIC_URL',
  'Chief keeps the cosmic whale.':
    'Chief luôn là cá voi vũ trụ.',
  'A scheduled task needs a name and what to do.':
    'Việc theo lịch cần có tên và việc cần làm.',
  'That is too long for a scheduled task.':
    'Nội dung này quá dài cho một việc theo lịch.',
  'That reset code or link is invalid, already used, or expired.':
    'Mã hoặc liên kết đặt lại mật khẩu không hợp lệ, đã được dùng, hoặc đã hết hạn.',
  'Your current password is not correct.': 'Mật khẩu hiện tại không đúng.',
  'That is the password you already have.': 'Đó chính là mật khẩu bạn đang dùng.',
  'That does not look like an email address.': 'Đó không giống một địa chỉ email.',
  'Registration is closed on this deployment.': 'Bản triển khai này đã đóng đăng ký.',
  'No such device is signed in.': 'Không có thiết bị nào như vậy đang đăng nhập.',
  'Choose what this is about, what kind of feedback it is and how much it affects you.': 'Hãy chọn góp ý về phần nào, thuộc loại nào và ảnh hưởng tới bạn ra sao.',
  'Say what this is about.': 'Hãy cho biết góp ý về điều gì.',
  'Choose one of the problems offered.': 'Hãy chọn một trong các loại vấn đề có sẵn.',
  'Say which conversation the answer is in.': 'Hãy cho biết câu trả lời nằm trong cuộc trò chuyện nào.',
  'Say what you expected, and what happened instead.': 'Hãy cho biết bạn mong đợi điều gì, và điều gì đã xảy ra.',
  'That is too long to send — keep it under 5,000 characters.': 'Nội dung quá dài — hãy giữ dưới 5.000 ký tự.',
  'You have sent a lot of feedback in the last hour. Try again a little later.': 'Bạn đã gửi nhiều góp ý trong một giờ qua. Hãy thử lại sau một lát.',
  'That conversation was not found.': 'Không tìm thấy cuộc trò chuyện đó.',
  'An incognito conversation is not kept, so it cannot be included.': 'Cuộc trò chuyện ẩn danh không được lưu lại, nên không thể đính kèm.',
  'That feedback was not found.': 'Không tìm thấy góp ý đó.',
  'Those are not the current documents. Reload the page to read them.':'Đó không phải bản hiện hành của các văn bản. Hãy tải lại trang để đọc chúng.',
  'That email is already registered.': 'Email này đã được đăng ký.',
  'This account has been suspended.': 'Tài khoản này đã bị tạm khoá.',
  'Enter the code from your authenticator app.': 'Nhập mã từ ứng dụng xác thực của bạn.',
  'That code is not right. Try the next one.': 'Mã không đúng. Hãy thử mã tiếp theo.',
  'Start the setup again — no pending secret was found.': 'Hãy bắt đầu cài đặt lại — không tìm thấy mã bí mật đang chờ.',
  'That code is not right. Check your authenticator app and try again.':
    'Mã không đúng. Kiểm tra ứng dụng xác thực rồi thử lại.',
  'Your password is not correct.': 'Mật khẩu không đúng.',
  'That code is not right.': 'Mã không đúng.',
  'You have used {0} of your {1} shared tokens this month. Add your own API key in Settings → Providers to keep going without a limit.':
    'Bạn đã dùng {0} trên {1} token dùng chung tháng này. Thêm API key của riêng bạn trong Cài đặt → Nhà cung cấp để tiếp tục không giới hạn.',

  /* ── lưu trữ của artifact & tệp ────────────────────────────────── */
  'A storage key cannot be empty.': 'Khoá lưu trữ không được để trống.',
  'That value is {0}KB, over the {1}KB limit for one key.': 'Giá trị này {0}KB, vượt giới hạn {1}KB cho một khoá.',
  'This artifact already has {0} stored keys, which is the limit.': 'Artifact này đã lưu {0} khoá, là mức tối đa.',
  'Artifact storage for this account is full. Clear some values first.':
    'Bộ nhớ artifact của tài khoản này đã đầy. Hãy xoá bớt giá trị trước.',
  '{0} is empty.': '{0} trống.',
  '{0} is {1}. The limit is {2} per file.': '{0} có dung lượng {1}. Giới hạn là {2} mỗi tệp.',
  'That document came to {0}, over the {1} limit.': 'Tài liệu đó có dung lượng {0}, vượt giới hạn {1}.',
  'That is {0} files; {1} at a time is the limit.': 'Đó là {0} tệp; mỗi lần tối đa {1} tệp.',
  'One of those files is no longer available.': 'Một trong các tệp đó không còn nữa.',
  'That document came to {0}MB, over the {1}MB limit for a single file.':
    'Tài liệu đó có dung lượng {0}MB, vượt giới hạn {1}MB cho một tệp.',
  'Only a page the assistant wrote can be run. Uploaded files are shown as source.':
    'Chỉ chạy được trang do trợ lý viết. Tệp tải lên được hiển thị dưới dạng mã nguồn.',
  'That file was uploaded, so there is no source to rewrite.': 'Tệp đó được tải lên, nên không có mã nguồn để viết lại.',
  'No such picture in this document.': 'Không có hình này trong tài liệu.',
  'There is no such version of this file.': 'Tệp này không có phiên bản đó.',
  'That path is too long.': 'Đường dẫn quá dài.',
  'Give an absolute path, such as D:\\projects or /home/me/code.':
    'Hãy nhập đường dẫn tuyệt đối, ví dụ D:\\projects hoặc /home/me/code.',

  /* ── kết nối dịch vụ ───────────────────────────────────────────── */
  'Settings → Developer settings → Personal access tokens → Fine-grained tokens.':
    'Settings → Developer settings → Personal access tokens → Fine-grained tokens (trong GitHub).',
  'github_pat_… or ghp_…': 'github_pat_… hoặc ghp_…',
  'GitHub rejected that token (HTTP {0}).': 'GitHub từ chối token đó (HTTP {0}).',
  'notion.so/my-integrations → New integration → Internal Integration Secret. Then share the pages you want it to see with that integration.':
    'notion.so/my-integrations → New integration → Internal Integration Secret. Sau đó chia sẻ các trang bạn muốn nó thấy với integration đó.',
  'ntn_… or secret_…': 'ntn_… hoặc secret_…',
  'Notion rejected that token (HTTP {0}).': 'Notion từ chối token đó (HTTP {0}).',
  'api.slack.com/apps → your app → OAuth & Permissions → Bot User OAuth Token.':
    'api.slack.com/apps → ứng dụng của bạn → OAuth & Permissions → Bot User OAuth Token.',
  'Slack rejected that token ({0}).': 'Slack từ chối token đó ({0}).',
  'Message @BotFather on Telegram → /newbot → it gives you a token. Then message your bot once, or add it to a group, so it has somewhere to post.':
    'Nhắn @BotFather trên Telegram → /newbot → nó sẽ đưa bạn một token. Sau đó nhắn cho bot một lần, hoặc thêm nó vào một nhóm, để nó có nơi đăng tin.',
  'Telegram rejected that token ({0}).': 'Telegram từ chối token đó ({0}).',
  'developers.facebook.com → create an app → Graph API Explorer → select your Page → grant pages_manage_posts and pages_read_engagement → then use the Access Token Debugger to "Extend" it into a long-lived Page token. A short-lived token is refused here, because it would stop working within the hour.':
    'developers.facebook.com → tạo ứng dụng → Graph API Explorer → chọn Trang của bạn → cấp quyền pages_manage_posts và pages_read_engagement → rồi dùng Access Token Debugger để "Extend" thành Page token dài hạn. Token ngắn hạn bị từ chối ở đây, vì nó sẽ hết hiệu lực trong vòng một giờ.',
  'Facebook rejected that token ({0}).': 'Facebook từ chối token đó ({0}).',
  'That token expires in under a day ({0}), so it would stop working almost immediately. Use the Access Token Debugger to extend it into a long-lived Page token first.':
    'Token đó hết hạn trong chưa đầy một ngày ({0}), nên sẽ ngừng hoạt động gần như ngay lập tức. Hãy dùng Access Token Debugger để gia hạn thành Page token dài hạn trước.',
  'That is a {0} token, not a Page token. Posting as a Page needs a Page token — pick your Page in the Graph API Explorer first.':
    'Đó là token {0}, không phải Page token. Đăng bài dưới tên Trang cần Page token — hãy chọn Trang của bạn trong Graph API Explorer trước.',
  'No connector called "{0}".': 'Không có kết nối nào tên "{0}".',
  'Paste the token.': 'Hãy dán token.',
  '{0} is not connected. The user can connect it in Settings → Connectors.':
    '{0} chưa được kết nối. Người dùng có thể kết nối trong Cài đặt → Kết nối.',
  'Give a GitHub API path beginning with "/", such as "/repos/owner/name/issues" — not "{0}".':
    'Hãy nhập đường dẫn GitHub API bắt đầu bằng "/", ví dụ "/repos/owner/name/issues" — không phải "{0}".',
  'That path does not stay on api.github.com.': 'Đường dẫn đó không nằm trong api.github.com.',
  'Slack refused: {0}': 'Slack từ chối: {0}',
  '"{0}" is not a write method. Use POST, PATCH, PUT or DELETE — reading is what `github` is for.':
    '"{0}" không phải phương thức ghi. Dùng POST, PATCH, PUT hoặc DELETE — đọc thì dùng `github`.',
  'Which chat? Telegram needs a chat id — a number, or "@channelname" for a public channel. A bot cannot start a conversation, so the user has to message it first.':
    'Cuộc trò chuyện nào? Telegram cần chat id — một con số, hoặc "@tenkenh" cho kênh công khai. Bot không tự bắt đầu hội thoại được, nên người dùng phải nhắn cho nó trước.',
  'Facebook refused: {0}': 'Facebook từ chối: {0}',
  'The server has no ENCRYPTION_KEY, so API keys cannot be stored safely. Add ENCRYPTION_KEY to the environment and restart (running locally, stopping and starting again generates one for you).':
    'Máy chủ không có ENCRYPTION_KEY, nên không thể lưu API key an toàn. Thêm ENCRYPTION_KEY vào biến môi trường rồi khởi động lại (khi chạy trên máy, dừng và chạy lại sẽ tự tạo một khoá).',

  /* ── máy tính & ghép nối ───────────────────────────────────────── */
  'That is not a pairing code. It looks like ABCD-2K7M.': 'Đó không phải mã ghép nối. Mã có dạng ABCD-2K7M.',
  'That code is not valid, has already been used, or has expired. Ask the computer for a new one.':
    'Mã không hợp lệ, đã được dùng, hoặc đã hết hạn. Hãy lấy mã mới từ máy tính.',
  'That setup link has expired or has already been used. Get a new one from the app.':
    'Liên kết cài đặt đó đã hết hạn hoặc đã được dùng. Hãy lấy liên kết mới trong ứng dụng.',
  'No such computer is paired to this account.': 'Không có máy tính nào như vậy được ghép với tài khoản này.',
  'The local tools on this machine are already in use by another account on this server. Only one account can drive one computer at a time — pair a worker to use your own machine instead.':
    'Công cụ cục bộ trên máy này đang được một tài khoản khác trên máy chủ sử dụng. Mỗi lúc chỉ một tài khoản điều khiển được một máy — hãy ghép nối worker để dùng máy của chính bạn.',

  /* ── email ─────────────────────────────────────────────────────── */
  'Resend returned {0}: {1}': 'Resend trả về {0}: {1}',
  '"{0}" is not an email address.': '"{0}" không phải địa chỉ email.',
  'An email with no subject line reads as spam. Give it one.': 'Email không có tiêu đề trông như thư rác. Hãy thêm tiêu đề.',
  'There is nothing to send — give a body.': 'Không có gì để gửi — hãy viết nội dung.',
  'No mail provider is configured on this deployment, so nothing can actually be sent — it would only be printed to the server log. Tell the user plainly that the email was NOT sent, and that the deployment needs GMAIL_USER and GMAIL_APP_PASSWORD (or RESEND_API_KEY, or SMTP_HOST) set for this tool to work. Do not claim to have sent it.':
    'Bản triển khai này chưa cấu hình dịch vụ gửi thư, nên không gửi được gì — nội dung chỉ được in ra log máy chủ. Email CHƯA được gửi; cần đặt GMAIL_USER và GMAIL_APP_PASSWORD (hoặc RESEND_API_KEY, hoặc SMTP_HOST) để công cụ này hoạt động.',
  'Give the address to send to — this account has no email of its own on record.':
    'Hãy cho biết địa chỉ cần gửi tới — tài khoản này không có email riêng được lưu.',
  'That is {0} recipients; {1} is the limit for one email.': 'Đó là {0} người nhận; mỗi email tối đa {1} người.',
  'The email was NOT sent: the mail provider refused it ({0}). Say so plainly.':
    'Email CHƯA được gửi: dịch vụ gửi thư đã từ chối ({0}).',
  'your own account address': 'địa chỉ email tài khoản của bạn',
  'every recipient was refused ({0}): {1}': 'mọi người nhận đều bị từ chối ({0}): {1}',

  /* ── MCP ───────────────────────────────────────────────────────── */
  'The server did not answer within {0}s.': 'Máy chủ không trả lời trong vòng {0} giây.',
  '{0} returned HTTP {1}: {2}': '{0} trả về HTTP {1}: {2}',
  'The stream ended before the server answered.': 'Luồng dữ liệu kết thúc trước khi máy chủ trả lời.',
  'The server accepted the request but sent no answer.': 'Máy chủ đã nhận yêu cầu nhưng không trả lời.',
  'Its stored {0} could not be decrypted ({1}). That usually means ENCRYPTION_KEY has changed since the server was added — remove it and add it again.':
    'Không giải mã được {0} đã lưu ({1}). Thường là do ENCRYPTION_KEY đã thay đổi kể từ khi thêm máy chủ — hãy xoá rồi thêm lại.',
  'Its stored {0} could not be read back — remove the server and add it again.':
    'Không đọc lại được {0} đã lưu — hãy xoá máy chủ rồi thêm lại.',
  'Its tool names would collide with the server "{0}". Rename one of them.':
    'Tên công cụ của nó sẽ trùng với máy chủ "{0}". Hãy đổi tên một trong hai.',
  '"{0}" is not a valid MCP tool name.': '"{0}" không phải tên công cụ MCP hợp lệ.',
  'Give the server a name.': 'Hãy đặt tên cho máy chủ.',
  'That name has no letters or digits in it — give it a plain name.': 'Tên đó không có chữ hay số — hãy đặt tên đơn giản.',
  '"{0}" and the server you already have called "{1}" would both be addressed as "{2}", and their tools would collide. Pick a name that differs by more than punctuation.':
    '"{0}" và máy chủ bạn đã có tên "{1}" sẽ cùng được gọi là "{2}", và công cụ của chúng sẽ trùng nhau. Hãy chọn tên khác nhau không chỉ ở dấu câu.',
  'A stdio server runs a program on this server with access to everyone’s stored keys, so only an administrator can add one. An http server works for any account.':
    'Máy chủ stdio chạy một chương trình trên máy chủ này và truy cập được key của mọi người, nên chỉ quản trị viên được thêm. Máy chủ http thì tài khoản nào cũng dùng được.',
  'Give the command that starts the server.': 'Hãy nhập lệnh khởi động máy chủ.',
  'Give an http(s) URL for the server.': 'Hãy nhập URL http(s) của máy chủ.',
  'That server did not start: {0}': 'Máy chủ đó không khởi động được: {0}',
  'No such MCP server.': 'Không có máy chủ MCP này.',
  'A stdio server runs a program on this server with access to everyone’s stored keys, so only an administrator can switch one on.':
    'Máy chủ stdio chạy một chương trình trên máy chủ này và truy cập được key của mọi người, nên chỉ quản trị viên được bật.',
  'Up-to-date documentation for any library or framework, fetched on demand. Stops the assistant answering from a stale memory of an API that has changed.':
    'Tài liệu mới nhất cho mọi thư viện hay framework, lấy về khi cần. Giúp trợ lý không trả lời theo trí nhớ cũ về một API đã thay đổi.',
  'Builds a graph of a codebase, so questions like "what calls this" and "what breaks if I change it" are answered from the code rather than guessed.':
    'Dựng đồ thị của một codebase, để các câu hỏi như "cái gì gọi hàm này" và "sửa chỗ này thì hỏng gì" được trả lời từ mã thật thay vì đoán.',
  'Packs a whole repository into one file a model can read at once. Useful for a review or an audit, where the shape of everything matters more than any one file.':
    'Gói cả một repository thành một tệp mà model đọc được một lần. Hữu ích khi review hay audit, khi bức tranh tổng thể quan trọng hơn từng tệp.',
  'Reads and writes files under folders you name. Note this app already has its own file tools; this is for reaching a folder outside the workspace on purpose.':
    'Đọc và ghi tệp trong các thư mục bạn chỉ định. Lưu ý ứng dụng này đã có công cụ tệp riêng; cái này dùng khi bạn cố ý cần tới một thư mục ngoài thư mục làm việc.',
  "GitHub's own server: issues, pull requests, code search, actions. Wider than this app's built-in `github` tool, which is the REST API by hand.":
    'Máy chủ chính thức của GitHub: issue, pull request, tìm mã, actions. Rộng hơn công cụ `github` có sẵn của ứng dụng này, vốn gọi REST API thủ công.',
  'Runs read-only queries against a Postgres database and reads its schema. For answering questions from real data.':
    'Chạy truy vấn chỉ đọc trên cơ sở dữ liệu Postgres và đọc schema. Để trả lời câu hỏi từ dữ liệu thật.',
  'Reads errors and stack traces from Sentry, so a bug report can start from what actually happened rather than a description of it.':
    'Đọc lỗi và stack trace từ Sentry, để một báo cáo lỗi bắt đầu từ điều thực sự đã xảy ra thay vì lời mô tả.',
  "Browser automation with an accessibility-tree view of the page. This app's own sandbox does the same job; use this when you want Playwright's own tooling.":
    'Tự động hoá trình duyệt với góc nhìn cây trợ năng của trang. Sandbox của ứng dụng này làm được việc tương tự; dùng cái này khi bạn muốn bộ công cụ của Playwright.',
  'Reads a Figma file: frames, layers, styles and measurements. For turning a design into markup without eyeballing a screenshot.':
    'Đọc tệp Figma: frame, layer, style và kích thước. Để chuyển thiết kế thành mã giao diện mà không phải ước lượng bằng mắt qua ảnh chụp.',
  "Notion's own server — richer than this app's `notion_search`, which only finds pages.":
    'Máy chủ chính thức của Notion — đầy đủ hơn `notion_search` của ứng dụng này, vốn chỉ tìm trang.',
  "Fetches a URL and converts it to Markdown. Overlaps this app's `web_fetch`; worth it for the cleaner conversion on documentation sites.":
    'Tải một URL và chuyển thành Markdown. Trùng một phần với `web_fetch` của ứng dụng này; đáng dùng vì chuyển đổi gọn hơn trên các trang tài liệu.',
  'A structured scratchpad for working through a hard problem in steps, revising earlier ones as it goes.':
    'Một bảng nháp có cấu trúc để giải một bài toán khó theo từng bước, sửa lại các bước trước trong lúc làm.',

  /* ── tìm kết nối (connectorDirectory.js) ───────────────────────── */
  'Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks and Contacts: search and send mail, find and read files, see and add events.':
    'Gmail, Drive, Lịch, Tài liệu, Trang tính, Biểu mẫu, Tasks và Danh bạ: tìm và gửi thư, tìm và đọc tệp, xem và thêm sự kiện.',
  'Repositories, issues, pull requests and code search on GitHub — read them, and open an issue or a pull request.':
    'Kho mã, issue, pull request và tìm mã trên GitHub — đọc chúng, và mở một issue hay một pull request.',
  'Finds and reads the Notion pages you share with it.': 'Tìm và đọc các trang Notion bạn chia sẻ với nó.',
  'Posts messages to a Slack channel as your bot.': 'Đăng tin nhắn vào một kênh Slack dưới tên bot của bạn.',
  'Reads the transcript of a YouTube video, so it can be summarised or quoted.':
    'Đọc lời thoại của một video YouTube để tóm tắt hoặc trích dẫn.',
  'Sends messages from your own Telegram bot to a chat or a group.':
    'Gửi tin nhắn từ bot Telegram của riêng bạn tới một cuộc trò chuyện hay một nhóm.',
  'Publishes posts to a Facebook Page you manage.': 'Đăng bài lên một Trang Facebook bạn quản lý.',
  'None of those is in the connector directory ({0}). Call search_connectors first and use the ids it gives.':
    'Không mục nào trong số đó có trong danh mục kết nối ({0}). Hãy gọi search_connectors trước và dùng đúng các id nó trả về.',

  /* ── model & nhà cung cấp ──────────────────────────────────────── */
  'Which model?': 'Model nào?',
  '"{0}" is not a decision. It is "apply" or "decline".': '"{0}" không phải một lựa chọn. Chỉ có "apply" hoặc "decline".',
  'That model is not in the library.': 'Model đó không có trong thư viện.',
  '{0} returned HTTP {1}': '{0} trả về HTTP {1}',
  '{0} returned an unexpected shape.': '{0} trả về dữ liệu không đúng dạng.',
  'Enter an OpenRouter model id such as "inclusionai/ling-3.0-flash:free", or paste its page URL.':
    'Nhập id model OpenRouter, ví dụ "inclusionai/ling-3.0-flash:free", hoặc dán URL trang của nó.',
  'OpenRouter has no model called "{0}". Check the id and try again.':
    'OpenRouter không có model nào tên "{0}". Kiểm tra id rồi thử lại.',
  '"{0}" returns {1} output, which this app cannot display. Only text models can be added.':
    '"{0}" trả về đầu ra {1}, mà ứng dụng này không hiển thị được. Chỉ thêm được model văn bản.',
  '"{0}" cannot call tools, so it would not be able to do anything in Agent mode — only talk about it. Pick a model whose OpenRouter page lists "tools" support.':
    '"{0}" không gọi được công cụ, nên ở chế độ Agent nó chỉ nói chứ không làm được gì. Hãy chọn model mà trang OpenRouter ghi có hỗ trợ "tools".',
  'No {0} key on this account.': 'Tài khoản này không có key {0}.',
  '"{0}" names the provider "{1}", which is not one of: {2}.': '"{0}" ghi nhà cung cấp "{1}", không thuộc: {2}.',
  'Unknown model "{0}". Pick one from the model browser.': 'Không rõ model "{0}". Hãy chọn một model trong bộ chọn model.',
  'Unsupported provider "{0}"': 'Nhà cung cấp "{0}" không được hỗ trợ',
  'No API key for {0}. Add one in Settings → Providers.': 'Chưa có API key cho {0}. Thêm key trong Cài đặt → Nhà cung cấp.',
  '{0}: the provider dropped that reply; starting it again.': '{0}: nhà cung cấp đã bỏ dở câu trả lời; đang chạy lại.',
  '{0}: {1} stopped mid-answer; starting that reply again.': '{0}: {1} dừng giữa chừng; đang viết lại câu trả lời.',
  '{0}: every key was refused{1}.': '{0}: mọi key đều bị từ chối{1}.',
  '{0} could not reach this model on any key: {1}': '{0} không gọi được mô hình này bằng key nào: {1}',
  '{0}: {1} could not reach the model, trying the next key.': '{0}: {1} không gọi được mô hình, đang thử key tiếp theo.',
  '{0} is not answering right now, so this reply comes from {1}. Your chosen model is unchanged.':
    '{0} hiện không trả lời được, nên câu trả lời này do {1} viết. Mô hình bạn chọn vẫn giữ nguyên.',
  'Unknown provider "{0}"': 'Không rõ nhà cung cấp "{0}"',
  'That is an empty key.': 'Key đang để trống.',
  'That key is already on this provider.': 'Key này đã có trong nhà cung cấp này.',
  'Eight keys per provider is the limit.': 'Mỗi nhà cung cấp tối đa tám key.',
  'Paste a key.': 'Hãy dán key vào.',
  'No provider called "{0}".': 'Không có nhà cung cấp nào tên "{0}".',
  'That does not look like a {0} key — those begin {1}.': 'Đây không giống key {0} — key {0} bắt đầu bằng {1}.',
  'That does not look like an {0} key — those begin {1}.': 'Đây không giống key {0} — key {0} bắt đầu bằng {1}.',
  '{0} refused that key. Check that it was copied whole and has not been revoked.':
    '{0} từ chối key này. Hãy kiểm tra key đã được sao chép đầy đủ và chưa bị thu hồi.',
  'That key belongs to the same OpenRouter account as key {0}. One account, one key: two keys of one account share its limits, so the second is no fallback. Add a key from another OpenRouter account.':
    'Key này thuộc cùng tài khoản OpenRouter với key {0}. Mỗi tài khoản chỉ gắn một key: hai key của cùng một tài khoản dùng chung hạn mức, nên key thứ hai không phải là dự phòng. Hãy thêm key từ một tài khoản OpenRouter khác.',
  'That free model is not in the library.': 'Model miễn phí đó không có trong thư viện.',
  'The free suggestion has to be a free model.': 'Model gợi ý miễn phí phải là model miễn phí.',
  'That paid model is not in the library.': 'Model trả phí đó không có trong thư viện.',
  'The paid suggestion has to be a paid model — the free one is chosen beside it.':
    'Model gợi ý trả phí phải là model trả phí — model miễn phí được chọn ở ô bên cạnh.',
  'There is no model to suggest for the keys on this account yet.': 'Chưa có model nào để gợi ý cho các key của tài khoản này.',
  'There is no key in that position.': 'Không có key ở vị trí đó.',

  /* ── đọc tài liệu Office, PDF, ZIP ─────────────────────────────── */
  'That .docx has no document part — it may be corrupt.': 'Tệp .docx đó không có phần nội dung — có thể đã hỏng.',
  'That .docx has no body.': 'Tệp .docx đó không có phần thân.',
  'That file is not a real Office document — it does not even start like one.':
    'Tệp đó không phải tài liệu Office thật — thậm chí phần đầu cũng không giống.',
  '{0} is not a format this can read.': '{0} không phải định dạng đọc được.',
  '"{0}" is not a format that can be created. Use one of: {1}. For a PDF, make a .docx or .html and use Print → Save as PDF in the file viewer.':
    '"{0}" không phải định dạng tạo được. Dùng một trong: {1}. Muốn có PDF, hãy tạo .docx hoặc .html rồi dùng In → Lưu thành PDF trong trình xem tệp.',
  'That is not valid JSON: {0}': 'JSON không hợp lệ: {0}',
  'That .pptx has no presentation part — it may be corrupt.': 'Tệp .pptx đó không có phần trình chiếu — có thể đã hỏng.',
  'That .xlsx has no workbook part — it may be corrupt.': 'Tệp .xlsx đó không có phần bảng tính — có thể đã hỏng.',
  'That file is too small to be an Office document.': 'Tệp đó quá nhỏ để là tài liệu Office.',
  'That file is not a ZIP archive, so it is not an Office document.': 'Tệp đó không phải tệp nén ZIP, nên không phải tài liệu Office.',
  'That archive says it is ZIP64 but has no ZIP64 record — it is corrupt.': 'Tệp nén đó ghi là ZIP64 nhưng không có bản ghi ZIP64 — tệp bị hỏng.',
  "That archive's ZIP64 record is not where it says.": 'Bản ghi ZIP64 của tệp nén đó không nằm ở chỗ nó ghi.',
  'No sheet in it could be found.': 'Không tìm thấy trang tính nào trong đó.',
  'That workbook has no sheet with anything in it.': 'Sổ tính đó không có trang tính nào có nội dung.',
  'That workbook is password-protected, so it cannot be read.': 'Sổ tính đó có mật khẩu bảo vệ nên không đọc được.',
  'That spreadsheet could not be read: {0}': 'Không đọc được bảng tính đó: {0}',
  'That spreadsheet could not be read.': 'Không đọc được bảng tính đó.',
  'That spreadsheet took longer than {0}s to read, so reading it was stopped.': 'Bảng tính đó đọc quá {0} giây nên đã dừng đọc.',
  'That archive is truncated or corrupt.': 'Tệp nén đó bị cắt cụt hoặc hỏng.',
  'That archive is corrupt — its table of contents does not line up.': 'Tệp nén đó bị hỏng — mục lục bên trong không khớp.',
  'That document is password-protected, so it cannot be read.': 'Tài liệu đó có mật khẩu bảo vệ nên không đọc được.',
  'This document has no part called {0}.': 'Tài liệu này không có phần nào tên {0}.',
  '{0} claims to be {1} bytes, which is too large to read.': '{0} ghi dung lượng {1} byte, quá lớn để đọc.',
  "This document's {0} is not where its table of contents says it is.":
    'Phần {0} của tài liệu này không nằm ở vị trí mục lục ghi.',
  '{0} uses compression method {1}, which is not supported.': '{0} dùng phương thức nén {1}, chưa được hỗ trợ.',
  '{0} could not be decompressed: {1}': 'Không giải nén được {0}: {1}',
  'That PDF could not be opened: {0}': 'Không mở được tệp PDF đó: {0}',
  'That PDF took longer than {0}s to read, so reading it was stopped.': 'Tệp PDF đó đọc quá {0} giây nên đã dừng đọc.',
  'That PDF could not be read: {0}': 'Không đọc được tệp PDF đó: {0}',
  'That PDF could not be read: its reader stopped ({0}).': 'Không đọc được tệp PDF đó: trình đọc đã dừng ({0}).',
  'That PDF could not be read.': 'Không đọc được tệp PDF đó.',
  '{0} is an image. A source has to be something the assistant can quote — send pictures in a message instead, where it can look at them.':
    '{0} là hình ảnh. Nguồn phải là thứ trợ lý trích dẫn được — hãy gửi ảnh trong tin nhắn, nơi trợ lý có thể nhìn thấy.',
  '{0} has no text in it — it may be empty, protected, or made entirely of pictures. Nothing in it can be quoted, so it would be a source in name only.':
    '{0} không có chữ — có thể trống, bị bảo vệ, hoặc toàn là hình. Không trích dẫn được gì, nên chỉ là nguồn trên danh nghĩa.',
  '{0} has no text in it — it is a scan or photographs of pages. Nothing in it can be quoted, so it would be a source in name only.':
    '{0} không có chữ — đó là bản quét hoặc ảnh chụp trang. Không trích dẫn được gì, nên chỉ là nguồn trên danh nghĩa.',
  '{0} has no text in it.': '{0} không có chữ.',

  /* ── lập chỉ mục & tìm kiếm ────────────────────────────────────── */
  'Indexing documents needs an embedding model, and this account has no key that provides one. Add an OpenAI or Google key in Settings → Providers. Anthropic and OpenRouter keys cannot do this — neither serves an embedding endpoint.':
    'Lập chỉ mục tài liệu cần model embedding, mà tài khoản này không có key nào cung cấp. Thêm key OpenAI hoặc Google trong Cài đặt → Nhà cung cấp. Key Anthropic và OpenRouter không làm được việc này — cả hai đều không có endpoint embedding.',
  'The embedding request failed: HTTP {0} {1}': 'Yêu cầu embedding thất bại: HTTP {0} {1}',
  'The embedding API returned {0} vectors for {1} chunks.': 'API embedding trả về {0} vector cho {1} đoạn.',
  'Too many chunks in one call ({0}). Send at most {1}.': 'Quá nhiều đoạn trong một lần gọi ({0}). Tối đa {1}.',
  '{0} returned HTTP {1}{2}': '{0} trả về HTTP {1}{2}',
  'DuckDuckGo returned HTTP {0}': 'DuckDuckGo trả về HTTP {0}',
  'DuckDuckGo served a rate-limit page rather than results.': 'DuckDuckGo trả về trang giới hạn tần suất thay vì kết quả.',
  'Nothing could be parsed out of the DuckDuckGo page.': 'Không đọc được gì từ trang DuckDuckGo.',
  'No search engine is configured. Set EXA_API_KEY or TAVILY_API_KEY, or leave DuckDuckGo enabled — it needs no key.':
    'Chưa cấu hình công cụ tìm kiếm. Đặt EXA_API_KEY hoặc TAVILY_API_KEY, hoặc để DuckDuckGo bật — nó không cần key.',
  'no results': 'không có kết quả',
  'Give a question to research.': 'Hãy đưa ra câu hỏi cần nghiên cứu.',
  'That research run belongs to another account.': 'Lượt nghiên cứu đó thuộc về tài khoản khác.',

  /* ── cơ sở dữ liệu & khởi động ─────────────────────────────────── */
  'DATABASE_URL is not set. On Vercel the filesystem is ephemeral, so a hosted database is required — create a Supabase project, copy its Transaction pooler string (Connect → port 6543) and set it as DATABASE_URL. See docs/database.md.':
    'Chưa đặt DATABASE_URL. Trên Vercel hệ thống tệp là tạm thời, nên cần cơ sở dữ liệu được host — tạo một project Supabase, chép chuỗi Transaction pooler (Connect → cổng 6543) và đặt làm DATABASE_URL. Xem docs/database.md.',
  'The database is not ready yet — initStore() must resolve first.': 'Cơ sở dữ liệu chưa sẵn sàng — initStore() phải hoàn tất trước.',
  'That server id belongs to another account.': 'Id máy chủ đó thuộc về tài khoản khác.',
  'Process {0} is already using the database at {1}. Two processes writing to one PGlite database corrupt it beyond repair, so this one is stopping before it starts. Stop the other one, or set DATA_DIR to somewhere else.':
    'Tiến trình {0} đang dùng cơ sở dữ liệu tại {1}. Hai tiến trình cùng ghi vào một cơ sở dữ liệu PGlite sẽ làm hỏng không sửa được, nên tiến trình này dừng trước khi chạy. Hãy dừng tiến trình kia, hoặc đặt DATA_DIR sang chỗ khác.',
  'Another copy of Synapsez is already running on port {0} and using {1}. Two processes writing to one database will damage it, so this one is stopping. Close the other one — or set PORT and DATA_DIR to run a second instance properly.':
    'Một bản Synapsez khác đang chạy ở cổng {0} và dùng {1}. Hai tiến trình cùng ghi vào một cơ sở dữ liệu sẽ làm hỏng nó, nên bản này dừng lại. Hãy đóng bản kia — hoặc đặt PORT và DATA_DIR để chạy bản thứ hai đúng cách.',
  'The local database is not installed. Run `npm install` in this folder — @electric-sql/pglite is what Synapsez stores everything in when there is no DATABASE_URL. If you installed with --omit=dev or --production, install again without it.':
    'Chưa cài cơ sở dữ liệu cục bộ. Chạy `npm install` trong thư mục này — Synapsez lưu mọi thứ vào @electric-sql/pglite khi không có DATABASE_URL. Nếu bạn đã cài với --omit=dev hoặc --production, hãy cài lại không kèm tuỳ chọn đó.',

  /* ── công cụ của trợ lý ────────────────────────────────────────── */
  'Give at least one task.': 'Hãy đưa ít nhất một việc.',
  'That is {0} tasks; {1} at once is the limit. Do the most important ones first.':
    'Đó là {0} việc; tối đa {1} việc một lần. Hãy làm những việc quan trọng nhất trước.',
  '"{0}" is not a number this can read.': '"{0}" không phải con số đọc được.',
  '"{0}" has no meaning in a calculation. Use numbers, + - * / ^ % ! ( ), lists and the named functions.':
    '"{0}" không có nghĩa trong phép tính. Dùng số, + - * / ^ % ! ( ), danh sách và các hàm có tên.',
  'Expected {0} in "{1}" — the expression is incomplete or mis-bracketed.':
    'Cần {0} trong "{1}" — biểu thức chưa đầy đủ hoặc sai ngoặc.',
  '"{0}" ends before it is finished.': '"{0}" kết thúc khi chưa hoàn chỉnh.',
  'A list on its own is not a number. Use it inside a function, like sum([1, 2, 3]).':
    'Một danh sách đứng riêng không phải con số. Hãy dùng trong một hàm, ví dụ sum([1, 2, 3]).',
  '"{0}" is not a function this knows. Available: {1}; constants {2}.': '"{0}" không phải hàm được biết. Hiện có: {1}; hằng số {2}.',
  '{0} took more than {1}s to send that file, so it was stopped. The server is slow or the file is very large — try once more, or look for another copy (a publisher or library page), or read it as text with web_fetch.':
    '{0} mất hơn {1} giây để gửi tệp đó nên đã bị dừng. Máy chủ chậm hoặc tệp rất lớn — thử lại một lần, hoặc tìm bản khác (trang nhà xuất bản hay thư viện), hoặc đọc dạng văn bản bằng web_fetch.',
  '{0} has no file at that address (HTTP 404). Check the link, and that spaces are written %20.': '{0} không có tệp ở địa chỉ đó (HTTP 404). Kiểm tra lại liên kết, và dấu cách phải viết là %20.',
  'There is no rate from {0} to {1} today.': 'Hôm nay không có tỷ giá từ {0} sang {1}.',
  '{0} needs at least {1} argument(s).': '{0} cần ít nhất {1} đối số.',
  'A factorial is of a whole number from 0 up.': 'Giai thừa chỉ tính cho số nguyên từ 0 trở lên.',
  'That factorial is too large to be a finite number.': 'Giai thừa đó quá lớn, không còn là số hữu hạn.',
  'pmt needs a number of periods other than 0.': 'pmt cần số kỳ khác 0.',
  'irr needs at least one negative and one positive cash flow.': 'irr cần ít nhất một dòng tiền âm và một dòng tiền dương.',
  'irr found no rate that brings these cash flows to zero.': 'irr không tìm được lãi suất nào đưa các dòng tiền này về 0.',
  'geomean needs positive numbers.': 'geomean cần các số dương.',
  'mod by zero has no answer.': 'mod cho 0 không có kết quả.',
  '"{0}" has something where a number should be.': '"{0}" có thứ gì đó ở chỗ lẽ ra là con số.',
  'That divides by zero, which has no answer. Check the denominator.': 'Phép tính chia cho 0, không có kết quả. Kiểm tra mẫu số.',
  '"{0}" has something left over after the expression — check the brackets and operators.':
    '"{0}" còn thừa ký tự sau biểu thức — kiểm tra ngoặc và toán tử.',
  'There is nothing to calculate.': 'Không có gì để tính.',
  'That expression is too long to be arithmetic.': 'Biểu thức quá dài để là phép tính số học.',
  'That does not come out to a finite number. Check for a division by zero or an overflow.':
    'Kết quả không phải số hữu hạn. Kiểm tra phép chia cho 0 hoặc tràn số.',
  '"{0}" is not a chart this draws. Use one of: {1}.': '"{0}" không phải loại biểu đồ vẽ được. Dùng một trong: {1}.',
  'Give `data.labels` — one label per point.': 'Hãy cung cấp `data.labels` — mỗi điểm một nhãn.',
  'Give `data.series` — at least one { name, values }.': 'Hãy cung cấp `data.series` — ít nhất một { name, values }.',
  'Series "{0}" has {1} values but there are {2} labels. They must match.':
    'Chuỗi "{0}" có {1} giá trị nhưng có {2} nhãn. Hai số này phải bằng nhau.',
  '"{0}" is not a valid URL.': '"{0}" không phải URL hợp lệ.',
  '{0} returned HTTP {1} {2}': '{0} trả về HTTP {1} {2}',
  '{0} returned {1} bytes, which is too large to read.': '{0} trả về {1} byte, quá lớn để đọc.',
  '{0} returned a PDF with no text in it — it is a scan or photographs of pages, so there is nothing to read.':
    '{0} trả về một PDF không có chữ — đây là bản scan hoặc ảnh chụp các trang, nên không có gì để đọc.',
  '{0} returned a {1} with no text in it.': '{0} trả về một tệp {1} không có chữ nào bên trong.',
  '{0} returned a file of type {1}, which is not text and not a document that can be read. Use download_file if the bytes themselves are wanted.':
    '{0} trả về tệp kiểu {1}, không phải văn bản và cũng không phải tài liệu đọc được. Dùng download_file nếu cần chính các byte đó.',
  '{0} sent more than {1}MB without saying how much was coming, and half a document cannot be opened.':
    '{0} gửi hơn {1}MB mà không báo trước dung lượng, và một tài liệu chỉ có một nửa thì không mở được.',
  'There is no file with the id {0} on this account.': 'Tài khoản này không có tệp nào với id {0}.',
  '{0} was uploaded by the user, not written by you, so it cannot be rewritten.':
    '{0} do người dùng tải lên, không phải do trợ lý viết, nên không viết lại được.',
  'That file could not be updated.': 'Không cập nhật được tệp đó.',
  '{0} was uploaded, so it has no source to read back.': '{0} được tải lên, nên không có mã nguồn để đọc lại.',
  '{0} was uploaded, so it has no version history — only files you made do.':
    '{0} được tải lên, nên không có lịch sử phiên bản — chỉ tệp do trợ lý tạo mới có.',
  '{0} has no v{1}. It is at v{2}; call without revision to list the drafts kept.':
    '{0} không có bản v{1}. Bản hiện tại là v{2}; gọi không kèm revision để xem các bản nháp còn lưu.',
  '"{0}" cannot be used as a note name. Pick a plain descriptive name.': '"{0}" không dùng làm tên ghi chú được. Hãy chọn tên mô tả đơn giản.',
  'Give the picture a short title, so it is labelled.': 'Hãy đặt tiêu đề ngắn cho hình để có nhãn.',
  'Give either `svg` or `html` to draw.': 'Hãy cung cấp `svg` hoặc `html` để vẽ.',
  'Give `svg` or `html`, not both — they are two different pictures.': 'Chỉ cung cấp `svg` hoặc `html`, không cả hai — đó là hai hình khác nhau.',
  'That is {0}KB of markup, over the {1}KB limit. A widget is re-read every time the conversation is opened. For something this large use `create_file` with format "html", which is a document rather than an inline picture.':
    'Đó là {0}KB mã, vượt giới hạn {1}KB. Widget được đọc lại mỗi lần mở cuộc trò chuyện. Với nội dung lớn như vậy hãy dùng `create_file` với format "html", là một tài liệu thay vì hình nhúng.',
  '`svg` has to start with an <svg> element. Use `html` for anything else.': '`svg` phải bắt đầu bằng thẻ <svg>. Dùng `html` cho mọi thứ khác.',
  'A widget cannot run scripts. Draw the finished picture, or use `create_file` for something interactive.':
    'Widget không chạy được script. Hãy vẽ hình hoàn chỉnh, hoặc dùng `create_file` cho nội dung tương tác.',
  'A widget cannot fetch anything — no images, fonts or stylesheets from the internet. Inline it, or draw it with shapes and text.':
    'Widget không tải được gì — không ảnh, font hay stylesheet từ internet. Hãy nhúng trực tiếp, hoặc vẽ bằng hình khối và chữ.',
  'Give the `names` of the tools to load.': 'Hãy cung cấp `names` của các công cụ cần nạp.',
  'Give the chart a short title, so it is labelled.': 'Hãy đặt tiêu đề ngắn cho biểu đồ để có nhãn.',
  'There is nothing to append.': 'Không có gì để nối thêm.',
  'Give the text to replace.': 'Hãy cung cấp đoạn văn bản cần thay.',
  'That text is not in "{0}". Read it back with memory_read first — it must match exactly.':
    'Đoạn văn bản đó không có trong "{0}". Hãy đọc lại bằng memory_read trước — phải khớp chính xác.',
  'That text appears {0} times in "{1}". Include more surrounding words so it matches once only.':
    'Đoạn văn bản đó xuất hiện {0} lần trong "{1}". Hãy thêm các từ xung quanh để chỉ khớp một lần.',
  'There is no workflow with the id "{0}". Call workflow_status to see them.':
    'Không có chuỗi việc nào với id "{0}". Gọi workflow_status để xem danh sách.',
  'Describe the image you want.': 'Hãy mô tả hình bạn muốn.',
  'Making pictures needs a Google API key, and this account has none. Tell the user to add one in Settings → Providers → Google Gemini. Their OpenRouter key cannot do this — image models are not part of that catalogue here.':
    'Tạo hình cần Google API key, mà tài khoản này chưa có. Hãy thêm key trong Cài đặt → Nhà cung cấp → Google Gemini. Key OpenRouter không làm được việc này — model tạo hình không nằm trong danh mục đó ở đây.',
  'Give the `url` of the page to read.': 'Hãy cung cấp `url` của trang cần đọc.',
  'Say what to extract, in `what` — for example "the plans and their prices".':
    'Hãy nói cần trích xuất gì, trong `what` — ví dụ "các gói và giá của chúng".',
  '"{0}" is not an http(s) URL. This reads web pages, not local files.': '"{0}" không phải URL http(s). Công cụ này đọc trang web, không đọc tệp cục bộ.',
  '{0} should be {1}, but got {2}.': '{0} phải là {1}, nhưng nhận được {2}.',
  '{0} must be one of {1}, but got {2}.': '{0} phải là một trong {1}, nhưng nhận được {2}.',
  '{0}{1} is required and was not given.': '{0}{1} là bắt buộc nhưng chưa được cung cấp.',

  /* ── truy cập mạng ─────────────────────────────────────────────── */
  'Only http and https URLs can be fetched — "{0}" is not one.': 'Chỉ tải được URL http và https — "{0}" không phải.',
  '{0} is a private address. This tool only reaches the public internet.': '{0} là địa chỉ nội bộ. Công cụ này chỉ truy cập internet công khai.',
  'Could not resolve "{0}".': 'Không phân giải được "{0}".',
  '"{0}" resolves to the private address {1}. This tool only reaches the public internet.':
    '"{0}" trỏ tới địa chỉ nội bộ {1}. Công cụ này chỉ truy cập internet công khai.',
  'Too many redirects (more than {0}).': 'Chuyển hướng quá nhiều lần (hơn {0}).',

  /* ── chuỗi việc ────────────────────────────────────────────────── */
  'Workflow not found': 'Không tìm thấy chuỗi việc',
  'Pick one of the permissions: ask, guarded or auto.': 'Hãy chọn một trong các quyền: ask, guarded hoặc auto.',
  'A workflow needs at least one step.': 'Chuỗi việc cần ít nhất một bước.',
  'A workflow is capped at 20 steps. Split it, or make a step do more.': 'Chuỗi việc tối đa 20 bước. Hãy tách ra, hoặc gộp nhiều việc vào một bước.',
  'Step {0} has no instruction.': 'Bước {0} chưa có hướng dẫn.',
  'A tool in this step needs approval and nobody is watching. Approve it in the conversation, or set the approval policy to allow it, then run the workflow again.':
    'Một công cụ ở bước này cần được duyệt mà không có ai theo dõi. Hãy duyệt trong cuộc trò chuyện, hoặc đổi chế độ duyệt để cho phép, rồi chạy lại chuỗi việc.',
  'The step ran out of agent steps before finishing. Split it into smaller steps.':
    'Bước này dùng hết số bước của trợ lý trước khi xong. Hãy tách thành các bước nhỏ hơn.',
  'This step was interrupted while {0} was running. It is not repeated automatically, because there is no way to tell whether that had already happened.':
    'Bước này bị ngắt khi {0} đang chạy. Nó không tự chạy lại, vì không có cách biết việc đó đã xảy ra hay chưa.',
  'This step was interrupted {0} times and was not resumed again. Split it into smaller steps.':
    'Bước này bị ngắt {0} lần nên không tự chạy tiếp nữa. Hãy chia nó thành các bước nhỏ hơn.',
  'This step was interrupted while running. It is not repeated automatically, because there is no way to tell whether what it does had already happened.':
    'Bước này bị gián đoạn khi đang chạy. Nó không tự chạy lại, vì không có cách nào biết việc của nó đã xảy ra hay chưa.',
  'No such workflow.': 'Không có chuỗi việc này.',
  'This workflow is already running. It carries on where it left off on its own — wait for it, rather than starting a second copy that would repeat every step.':
    'Chuỗi việc này đang chạy. Nó sẽ tự tiếp tục từ chỗ đã dừng — hãy đợi, thay vì chạy bản thứ hai sẽ lặp lại mọi bước.',

  /* ── lý do một hành động cần được duyệt ── */
  'From the "{0}" MCP server — code outside this app, so it always asks.':
    'Từ máy chủ MCP "{0}" — mã nằm ngoài ứng dụng này, nên luôn hỏi trước.',
  'This command looks destructive or irreversible.':
    'Lệnh này có vẻ phá huỷ hoặc không thể hoàn tác.',
  'This command touches Windows system files.':
    'Lệnh này động tới tệp hệ thống của Windows.',
  'Downloads {0} onto your computer.':
    'Tải {0} về máy tính của bạn.',
  'Sends an email to {0}. It cannot be unsent.':
    'Gửi email tới {0}. Không thể thu hồi.',
  'Posts to {0}, where other people will read it.':
    'Đăng lên {0}, nơi người khác sẽ đọc.',
  'Sends a Telegram message to {0}.':
    'Gửi tin nhắn Telegram tới {0}.',
  'Publishes a post on your Facebook Page, publicly and immediately.':
    'Đăng bài lên Trang Facebook của bạn, công khai và ngay lập tức.',
  '{0} to GitHub {1} — other people will see this.':
    '{0} lên GitHub {1} — người khác sẽ thấy.',
  'Deletes {0} and everything under it. There is no undo.':
    'Xoá {0} và mọi thứ bên trong. Không thể hoàn tác.',
  'Deletes {0}. There is no undo.':
    'Xoá {0}. Không thể hoàn tác.',
  'Closes a window. Anything unsaved in it is lost.':
    'Đóng một cửa sổ. Mọi thứ chưa lưu trong đó sẽ mất.',
  'Stops {0}{1}. Anything unsaved in it is lost.':
    'Dừng {0}{1}. Mọi thứ chưa lưu trong đó sẽ mất.',
  'Replaces what is currently on your clipboard.':
    'Thay nội dung đang có trong bộ nhớ tạm của bạn.',
  'Forgets the search index for "{0}". The files stay; re-indexing them costs tokens.':
    'Xoá chỉ mục tìm kiếm của "{0}". Tệp vẫn giữ nguyên; lập chỉ mục lại sẽ tốn token.',
  'Forgets every indexed document. The files stay, but the whole index has to be rebuilt.':
    'Xoá chỉ mục của mọi tài liệu. Tệp vẫn giữ nguyên, nhưng phải dựng lại toàn bộ chỉ mục.',
  'Reads every document under {0} and sends the text to be embedded.':
    'Đọc mọi tài liệu trong {0} và gửi văn bản đi để tạo embedding.',
  'Moves the workspace to {0}. The file tools will work there from now on.':
    'Chuyển thư mục làm việc sang {0}. Từ giờ các công cụ tệp sẽ làm việc ở đó.',
  'This runs a program on your computer, not just opens a document.':
    'Việc này chạy một chương trình trên máy bạn, không chỉ mở tài liệu.',
  'This path belongs to Windows, not to your work.':
    'Đường dẫn này thuộc về Windows, không phải công việc của bạn.',
  'This path is outside your workspace.':
    'Đường dẫn này nằm ngoài thư mục làm việc.',
  'This key combination can close or delete things.':
    'Tổ hợp phím này có thể đóng hoặc xoá thứ gì đó.',
  'Starts a program that can do anything you can.':
    'Mở một chương trình có thể làm mọi thứ bạn làm được.',
  'a file':
    'một tệp',
  somebody:
    'ai đó',
  'a Slack channel':
    'một kênh Slack',
  'a chat':
    'một cuộc trò chuyện',
  'that folder':
    'thư mục đó',
  'that file':
    'tệp đó',
  'a program':
    'một chương trình',
  'another folder':
    'một thư mục khác',
  ' outright':
    ' ngay lập tức',

  /* ── MCP, tệp, nhà cung cấp, cơ sở dữ liệu ── */
  "stdio MCP servers run on each account's cloud computer, and this deployment has none: the Vercel Sandbox is switched off (SANDBOX_DISABLED). Use an http server, or switch the sandbox back on.":
    'Máy chủ MCP stdio chạy trên máy tính đám mây của từng tài khoản, nhưng bản triển khai này không có: Vercel Sandbox đang bị tắt (SANDBOX_DISABLED). Hãy dùng máy chủ http, hoặc bật lại sandbox.',
  'stdio MCP servers need either the cloud computer (VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID) or ALLOW_MCP_STDIO=1 on a machine you trust. Or use an http server.':
    'Máy chủ MCP stdio cần máy tính đám mây (VERCEL_TOKEN, VERCEL_TEAM_ID và VERCEL_PROJECT_ID) hoặc ALLOW_MCP_STDIO=1 trên máy bạn tin tưởng. Hoặc dùng máy chủ http.',
  'stdio servers need either the cloud computer (the Vercel Sandbox) or ALLOW_MCP_STDIO on a machine you trust, and this deployment has neither. An http server works everywhere.':
    'Máy chủ stdio cần máy tính đám mây (Vercel Sandbox) hoặc ALLOW_MCP_STDIO trên máy bạn tin tưởng, mà bản triển khai này không có cái nào. Máy chủ http thì chạy ở đâu cũng được.',
  'This conversation has read something from outside — a page, a search result, a server. A note saved now is read at the start of every later conversation, so check it carries nothing that came from there.':
    'Cuộc trò chuyện này đã đọc nội dung từ bên ngoài — một trang web, kết quả tìm kiếm hay một máy chủ. Ghi chú lưu lúc này sẽ được đọc ở đầu mọi cuộc trò chuyện sau, nên hãy kiểm tra để chắc nó không mang theo gì từ nguồn đó.',
  'The MCP bridge on the cloud computer did not come up in time.':
    'Cầu nối MCP trên máy tính đám mây không khởi động kịp.',
  'The connection to the cloud computer was lost.':
    'Kết nối tới máy tính đám mây đã bị mất.',
  'The server on the cloud computer answered with more than {0} MB, which was not read.':
    'Máy chủ trên máy tính đám mây trả lời dài quá {0} MB nên câu trả lời không được đọc.',
  'This account has checked {0} new MCP servers on the cloud computer today; it can check another in about {1}h. A server somebody has already added is still ready at once.':
    'Hôm nay tài khoản này đã kiểm tra {0} máy chủ MCP mới trên máy tính đám mây; khoảng {1} giờ nữa mới kiểm tra thêm được. Máy chủ người khác đã thêm trước đó vẫn dùng được ngay.',
  "New MCP servers are at today's limit for the whole app; another can be checked in about {0}h. A server somebody has already added is still ready at once.":
    'Việc kiểm tra máy chủ MCP mới đã chạm giới hạn hôm nay của toàn ứng dụng; khoảng {0} giờ nữa mới kiểm tra thêm được. Máy chủ người khác đã thêm trước đó vẫn dùng được ngay.',
  'The cloud computer for this server is not running.':
    'Máy tính đám mây cho máy chủ này đang không chạy.',
  'The cloud computer for this server could not be reached.':
    'Không liên lạc được với máy tính đám mây cho máy chủ này.',
  'The server on the cloud computer failed.':
    'Máy chủ trên máy tính đám mây bị lỗi.',
  'The "{0}" MCP server is not reachable: {1}':
    'Không kết nối được máy chủ MCP "{0}": {1}',
  'There is no MCP server called "{0}" on this account.':
    'Tài khoản này không có máy chủ MCP nào tên "{0}".',
  '{0} is in the old Office format, which cannot be read. Save it as .docx, .xlsx or .pptx and add that.':
    '{0} ở định dạng Office cũ, không đọc được. Hãy lưu thành .docx, .xlsx hoặc .pptx rồi thêm tệp đó.',
  '{0} is not a kind of file that can be read. PDFs, Word, Excel, PowerPoint, text and code work.':
    '{0} không phải loại tệp đọc được. Đọc được PDF, Word, Excel, PowerPoint, văn bản và mã nguồn.',
  'You own this deployment. Hand it to another administrator in Settings → People before deleting your account.': 'Bạn là chủ sở hữu của bản triển khai này. Hãy giao quyền sở hữu cho một quản trị viên khác trong Cài đặt → Người dùng trước khi xoá tài khoản.',
  'The deployment can only be handed to another active administrator.': 'Chỉ có thể giao quyền sở hữu cho một quản trị viên khác đang hoạt động.',
  'Choose what an administrator may do under Settings → People.': 'Hãy chọn việc quản trị viên được làm trong Cài đặt → Người dùng.',
  'A stdio server runs a program on this server with access to everyone’s stored keys, so only the owner of this deployment can use one.': 'Máy chủ stdio chạy một chương trình trên máy chủ này và có thể đọc key đã lưu của mọi người, nên chỉ chủ sở hữu mới dùng được.',
  'You do not have permission for that.': 'Bạn không có quyền làm việc đó.',
  'The mascot is one of: {0}.': 'Linh vật chỉ có thể là một trong: {0}.',
  'A badge is one of: {0}.': 'Huy hiệu chỉ có thể là một trong: {0}.',
  '{0} could not be drawn: {1}. Read its text instead.': 'Không vẽ được {0}: {1}. Hãy đọc phần chữ của tệp.',
  'This server could not draw {0}. Read its text instead.': 'Máy chủ này không vẽ được {0}. Hãy đọc phần chữ của tệp.',
  'Personal details are masked for this account, so {0} cannot be drawn and shown to a model. Read its text instead.': 'Tài khoản này đang che thông tin cá nhân nên không thể vẽ {0} để gửi cho model. Hãy đọc phần chữ của tệp.',
  'There is no such theme.': 'Không có theme này.',
  'You do not hold that theme yet.': 'Bạn chưa có theme này.',
  'There is no such title.': 'Không có danh hiệu này.',
  'You have not earned that title yet.': 'Bạn chưa đạt danh hiệu này.',
  'Say which title, or null for none.': 'Hãy chọn một danh hiệu, hoặc không đeo danh hiệu nào.',
  'A ranking is by quarter or by year.': 'Bảng xếp hạng chỉ có theo quý hoặc theo năm.',
  'There is no ranking for that period.': 'Không có bảng xếp hạng cho kỳ này.',
  'The default theme carries no badge: everybody has it.': 'Theme mặc định không có huy hiệu vì ai cũng có.',
  'That theme cannot be given.': 'Không thể trao theme này.',
  'That theme cannot be taken back.': 'Không thể thu hồi theme này.',
  'There is no such account.': 'Không có tài khoản này.',
  'That is not a year this can use.': 'Năm này không dùng được.',
  'A quarter is a number from 1 to 4.': 'Quý phải là số từ 1 đến 4.',
  'Say which year that quarter is in.': 'Hãy cho biết quý đó thuộc năm nào.',
  'Only the owner of this deployment can do that.': 'Chỉ chủ sở hữu của bản triển khai này mới làm được việc đó.',
  'The owner holds every permission already.': 'Chủ sở hữu đã có mọi quyền.',
  'Choose at least one thing this administrator may do.': 'Hãy chọn ít nhất một việc quản trị viên này được làm.',
  'The owner cannot be removed as an administrator.': 'Không thể gỡ quyền quản trị của chủ sở hữu.',
  'Only the owner can change another administrator, and nobody can change the owner.': 'Chỉ chủ sở hữu mới tác động được lên quản trị viên khác, và không ai tác động được lên chủ sở hữu.',
  "{0}'s free tier limits how long one request may be until an account has paid enough, and this conversation is longer. Add credit on {1}, or pick another model.":
    'Gói miễn phí của {0} giới hạn độ dài mỗi yêu cầu khi tài khoản chưa nạp đủ, và cuộc trò chuyện này dài hơn mức đó. Hãy nạp credit trên {1}, hoặc chọn model khác.',
  "{0}'s free tier needs the workspace owner to link an established GitHub account, or to add credit. Do either on {1}, or pick another model.":
    'Gói miễn phí của {0} yêu cầu chủ workspace liên kết một tài khoản GitHub đã dùng đủ lâu, hoặc nạp credit. Hãy làm một trong hai trên {1}, hoặc chọn model khác.',
  'That list is too long to work out in one call. Send fewer figures at a time.': 'Danh sách đó quá dài để tính trong một lần. Hãy gửi ít số hơn mỗi lần.',
  'No rate from {0} to {1}. Use ISO codes like USD, VND, EUR, or coin symbols like USDT, BTC.': 'Không có tỷ giá từ {0} sang {1}. Hãy dùng mã ISO như USD, VND, EUR, hoặc ký hiệu coin như USDT, BTC.',
  'Currencies are ISO codes like USD, VND, EUR, or coin symbols like USDT, BTC.': 'Tiền tệ là mã ISO như USD, VND, EUR, hoặc ký hiệu coin như USDT, BTC.',
  '{0}: every key is rate limited until {1}.':
    '{0}: mọi key đều bị giới hạn tần suất cho đến {1}.',
  '{0} The provider said: {1}':
    '{0} Nhà cung cấp cho biết: {1}',
  'The local database at {0} would not start. That usually means it was left locked or a file in it is damaged. If nothing else is running, moving that folder aside starts a fresh one — it holds your accounts and conversations, so keep the copy.':
    'Cơ sở dữ liệu cục bộ tại {0} không khởi động được. Thường là do nó còn bị khoá hoặc có tệp bị hỏng. Nếu không có gì khác đang chạy, di chuyển thư mục đó sang chỗ khác sẽ tạo cơ sở dữ liệu mới — thư mục đó chứa tài khoản và cuộc trò chuyện của bạn, nên hãy giữ lại bản sao.',
  'The local database at {0} would not start: {1}':
    'Cơ sở dữ liệu cục bộ tại {0} không khởi động được: {1}',

  /* ── ghi chú, tác vụ, tạo hình ── */
  'No note saved under "{0}". There is: {1}.':
    'Không có ghi chú nào tên "{0}". Hiện có: {1}.',
  'No notes are saved on this account.':
    'Tài khoản này chưa lưu ghi chú nào.',
  'No note saved under "{0}". The notes on this account are: {1}.':
    'Không có ghi chú nào tên "{0}". Các ghi chú trong tài khoản này: {1}.',
  'No note saved under "{0}" — there are no notes on this account at all.':
    'Không có ghi chú nào tên "{0}" — tài khoản này chưa có ghi chú nào.',
  /* "Trong tầm với" vì trong một dự án, những ghi chú đọc được gồm cả của dự án
     lẫn của tài khoản — nói "tài khoản" ở đây là nói thiếu một nửa. */
  'No note saved under "{0}". The notes in reach here are: {1}.':
    'Không có ghi chú nào tên "{0}". Những ghi chú dùng được ở đây: {1}.',
  'No note saved under "{0}" — there are no notes in reach here at all.':
    'Không có ghi chú nào tên "{0}" — ở đây chưa có ghi chú nào dùng được.',
  'There is no scheduled task with the id "{0}". Call list_tasks to see what is there.':
    'Không có tác vụ theo giờ nào với id "{0}". Gọi list_tasks để xem danh sách.',
  'There is nothing scheduled on this account to cancel.':
    'Tài khoản này không có tác vụ theo giờ nào để huỷ.',
  'Google declined to make that image: {0}':
    'Google từ chối tạo hình đó: {0}',
  'Google returned no image and gave no reason. Try describing it differently.':
    'Google không trả về hình nào và không nêu lý do. Hãy thử mô tả theo cách khác.',
  "{0}: this conversation ({1} tokens) no longer fits this model's {2}-token window. Compact it, start a new one, or pick a model with a larger window.":
    '{0}: cuộc trò chuyện này ({1} token) không còn vừa cửa sổ {2} token của model. Hãy thu gọn nó, mở cuộc mới, hoặc chọn model có cửa sổ lớn hơn.',
  '{0} has no stored source to add to. Pass the complete content instead.':
    '{0} không có nội dung gốc để nối thêm. Hãy gửi toàn bộ nội dung thay vào đó.',
  "No rate from {0} to {1}. Use ISO codes like USD, VND, EUR.":
    "Không có tỷ giá từ {0} sang {1}. Hãy dùng mã ISO như USD, VND, EUR.",
  "{0} returned HTTP {1}.":
    "{0} trả về HTTP {1}.",
  "Say which place — a city name, e.g. \"Hanoi\" or \"Ho Chi Minh City\".":
    "Hãy nói nơi nào — tên một thành phố, ví dụ \"Hanoi\" hoặc \"Ho Chi Minh City\".",
  "No place called \"{0}\" was found. Try the city's English name, e.g. \"Ho Chi Minh City\".":
    "Không tìm thấy nơi nào tên \"{0}\". Hãy thử tên tiếng Anh của thành phố, ví dụ \"Ho Chi Minh City\".",
  "Currencies are ISO codes: USD, VND, EUR, JPY…":
    "Tiền tệ dùng mã ISO: USD, VND, EUR, JPY…",
  "kind is one of: time, weather, exchange_rate.":
    "kind phải là một trong: time, weather, exchange_rate.",
  "This exact email — to {0}, subject \"{1}\" — was already accepted by the mail server a few minutes ago in this conversation, so it was NOT sent again. Treat the send as done and carry on. Only if the user explicitly asked for a second copy, call again with resend: true.":
    "Đúng email này — gửi tới {0}, tiêu đề \"{1}\" — đã được máy chủ thư nhận vài phút trước trong cuộc trò chuyện này, nên KHÔNG gửi lại lần nữa. Coi như đã gửi xong và làm tiếp. Chỉ khi người dùng yêu cầu rõ một bản thứ hai thì mới gọi lại với resend: true.",
  "\"{0}\" is not a date. Write it as YYYY-MM-DD or DD/MM/YYYY.":
    "\"{0}\" không phải là ngày. Hãy viết dạng YYYY-MM-DD hoặc DD/MM/YYYY.",
  "{0}/{1}/{2} is not a real date.":
    "{0}/{1}/{2} không phải là một ngày có thật.",
  "Both zones must be IANA names, e.g. \"Asia/Ho_Chi_Minh\", \"Europe/London\".":
    "Cả hai múi giờ phải là tên IANA, ví dụ \"Asia/Ho_Chi_Minh\", \"Europe/London\".",
  "Give the time as \"YYYY-MM-DD HH:MM\".":
    "Hãy đưa thời gian dạng \"YYYY-MM-DD HH:MM\".",
  "Country is a two-letter code, e.g. VN, US, JP.":
    "Quốc gia là mã hai chữ cái, ví dụ VN, US, JP.",
  "Lunar {0}/{1}{2}/{3} does not exist.":
    "Ngày âm lịch {0}/{1}{2}/{3} không tồn tại.",
  "op is one of: diff, add, info, to_lunar, to_solar, convert_time, holidays.":
    "op phải là một trong: diff, add, info, to_lunar, to_solar, convert_time, holidays.",
  "\"{0}\" is not a unit this knows. Try m, km, kg, lb, °C, l, km/h, GB, kWh, psi…":
    "\"{0}\" không phải đơn vị được hỗ trợ. Thử m, km, kg, lb, °C, l, km/h, GB, kWh, psi…",
  "Give the value as a number.":
    "Hãy đưa giá trị dạng số.",
  "Cannot convert {0} ({1}) to {2} ({3}).":
    "Không thể đổi {0} ({1}) sang {2} ({3}).",
  "No coin called \"{0}\".":
    "Không có đồng coin nào tên \"{0}\".",
  "Name at least one symbol — e.g. BTC, ETH, AAPL, FPT, VNINDEX, gold.":
    "Hãy nêu ít nhất một mã — ví dụ BTC, ETH, AAPL, FPT, VNINDEX, gold.",
  "kind is crypto or stock.":
    "kind là crypto hoặc stock.",
  "Name the place — e.g. \"Chợ Bến Thành\" or \"136 Lê Thánh Tôn, Quận 1, TP.HCM\".":
    "Hãy nêu địa điểm — ví dụ \"Chợ Bến Thành\" hoặc \"136 Lê Thánh Tôn, Quận 1, TP.HCM\".",
  "No place called \"{0}\" was found on OpenStreetMap. Try its street address, or a bigger landmark near it.":
    "Không tìm thấy địa điểm \"{0}\" trên OpenStreetMap. Thử địa chỉ đường phố của nó, hoặc một địa danh lớn hơn ở gần đó.",
  "OpenStreetMap's place search did not answer ({0}). Try again in a moment.":
    "Dịch vụ tìm địa điểm của OpenStreetMap không phản hồi ({0}). Hãy thử lại sau giây lát.",
  "OpenStreetMap's place search did not answer ({0}), so \"{1}\" could not be checked. Try again in a moment.":
    "Dịch vụ tìm địa điểm của OpenStreetMap không phản hồi ({0}), nên chưa kiểm tra được \"{1}\". Hãy thử lại sau giây lát.",
  "OpenStreetMap's place search did not answer (it failed a moment ago and is being rested). Try again in a moment.":
    'Dịch vụ tìm địa điểm của OpenStreetMap không phản hồi (vừa lỗi cách đây ít phút nên đang được cho nghỉ). Hãy thử lại sau giây lát.',
  'it failed a moment ago and is being rested':
    'vừa lỗi cách đây ít phút nên đang được cho nghỉ',
  "OpenStreetMap's place search did not answer{0}, and neither did its address search ({1}). Try again in a moment, or web_search for the places.":
    'Dịch vụ tìm địa điểm của OpenStreetMap không phản hồi{0}, dịch vụ tìm địa chỉ của nó cũng vậy ({1}). Hãy thử lại sau giây lát, hoặc dùng web_search để tìm các địa điểm.',
  "Say what to look for — \"quán ăn\", \"cà phê\", \"phở\", \"ATM\", \"bệnh viện\"…":
    "Hãy nói cần tìm gì — \"quán ăn\", \"cà phê\", \"phở\", \"ATM\", \"bệnh viện\"…",
  "OpenStreetMap took too long to answer, so this was stopped. Try again in a moment, or a smaller area.":
    "OpenStreetMap phản hồi quá lâu nên đã dừng. Hãy thử lại sau giây lát, hoặc với một khu vực nhỏ hơn.",
  "Where should I look? Name a place or an address in `near` — the person's location is not known here.":
    "Tìm ở đâu? Hãy nêu một địa điểm hoặc địa chỉ trong `near` — ở đây không biết vị trí của người dùng.",
  "op is find, nearby or distance.":
    "op là find, nearby hoặc distance.",
  "That address is not an RSS or Atom feed (no items found). Try web_fetch for an ordinary page.":
    "Địa chỉ này không phải nguồn RSS hay Atom (không có mục nào). Hãy dùng web_fetch cho trang thường.",
  "Those texts are too long to diff here.":
    "Hai văn bản quá dài để so sánh ở đây.",
  "algorithm is md5, sha1, sha256 or sha512.":
    "algorithm là md5, sha1, sha256 hoặc sha512.",
  "Not valid JSON: {0}":
    "JSON không hợp lệ: {0}",
  "Not a host name.":
    "Không phải tên miền.",
  "Not a valid regular expression: {0}":
    "Biểu thức chính quy không hợp lệ: {0}",
  "op is one of: count, hash, base64_encode, base64_decode, url_encode, url_decode, uuid, json_format, regex, diff, slug, remove_accents, upper, lower, title.":
    "op phải là một trong: count, hash, base64_encode, base64_decode, url_encode, url_decode, uuid, json_format, regex, diff, slug, remove_accents, upper, lower, title.",
  "There are no rows to analyse.":
    "Không có dòng nào để phân tích.",
  "Name a column. There are: {0}.":
    "Hãy nêu một cột. Các cột hiện có: {0}.",
  "No column \"{0}\". There are: {1}.":
    "Không có cột \"{0}\". Các cột hiện có: {1}.",
  "agg is sum, avg, min, max, median or count.":
    "agg là sum, avg, min, max, median hoặc count.",
  "op is describe, group or top.":
    "op là describe, group hoặc top.",
  "No file with the id \"{0}\" on this account.":
    "Tài khoản này không có tệp nào mang id \"{0}\".",
  "Give the table as `data` (CSV or a JSON array), or the `file_id` of an attached CSV.":
    "Hãy đưa bảng qua `data` (CSV hoặc mảng JSON), hoặc `file_id` của một tệp CSV đính kèm.",
  "JSON data must be an array of objects.":
    "Dữ liệu JSON phải là một mảng các object.",
  "Give the text or link the QR code should hold.":
    "Hãy đưa nội dung hoặc đường link cho mã QR.",
  "That is too long for a QR code a phone can read; keep it under 2,000 characters.":
    "Nội dung quá dài để điện thoại đọc được mã QR; hãy giữ dưới 2.000 ký tự.",
  "method is GET, HEAD, POST, PUT, PATCH or DELETE.":
    "method là GET, HEAD, POST, PUT, PATCH hoặc DELETE.",
  "Only http and https addresses.":
    "Chỉ chấp nhận địa chỉ http và https.",
  "Say what to look up.":
    "Hãy nói cần tra cứu gì.",
  "Wikipedia ({0}) has no article matching \"{1}\".":
    "Wikipedia ({0}) không có bài nào khớp với \"{1}\".",
  "Sends a {0} request to {1}, which may change something there.":
    "Gửi yêu cầu {0} tới {1}, có thể làm thay đổi dữ liệu ở đó.",
  "Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks and Contacts — each connected on its own, by signing in with Google.":
    "Gmail, Drive, Lịch, Tài liệu, Trang tính, Biểu mẫu, Tasks và Danh bạ — mỗi sản phẩm kết nối riêng, bằng cách đăng nhập với Google.",
  "Not set up on this deployment yet. The owner creates a free OAuth client in Google Cloud Console and sets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — see docs/google.md.":
    "Bản triển khai này chưa được thiết lập. Chủ sở hữu tạo một OAuth client miễn phí trong Google Cloud Console và đặt GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — xem docs/google.md.",
  "Google is not set up on this deployment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.":
    "Bản triển khai này chưa thiết lập Google. Hãy đặt GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET trước.",
  "The Google sign-in came back without a valid state. Start again from Settings.":
    "Đăng nhập Google trả về không có mã xác thực hợp lệ. Hãy bắt đầu lại từ Cài đặt.",
  "That Google sign-in was started from another session. Start again from Settings.":
    "Lần đăng nhập Google đó được bắt đầu từ một phiên khác. Hãy bắt đầu lại từ Cài đặt.",
  "The Google sign-in took too long. Start again from Settings.":
    "Đăng nhập Google quá lâu. Hãy bắt đầu lại từ Cài đặt.",
  "Google refused the sign-in ({0}).":
    "Google từ chối đăng nhập ({0}).",
  "Google did not give a refresh token, so scheduled runs could not reach it. Disconnect and connect again.":
    "Google không cấp refresh token, nên các lần chạy theo lịch sẽ không truy cập được. Hãy ngắt kết nối rồi kết nối lại.",
  "Google is not connected. The user can connect it in Settings → Connectors.":
    "Chưa kết nối Google. Người dùng có thể kết nối trong Cài đặt → Kết nối.",
  /* ── nút + : thêm tệp từ Google Drive ── */
  'Google Drive is not connected. Connect Google in Settings → Connectors and allow Drive.':
    'Chưa kết nối Google Drive. Hãy kết nối Google trong Cài đặt → Kết nối và cho phép Drive.',
  'That is not a Google Drive file.': 'Đó không phải một tệp Google Drive.',
  '{0} is a Google {1}, which has no file to attach. Open it in Drive instead.':
    '{0} là một Google {1}, không có tệp nào để đính kèm. Hãy mở nó trong Drive.',
  '{0} is {1} MB — over the limit for one file.': '{0} nặng {1} MB — vượt giới hạn cho một tệp.',
  '{0} is over the limit for one file.': '{0} vượt giới hạn cho một tệp.',
  '{0} does not say how big it is, so it was not fetched.': '{0} không cho biết kích thước, nên không được tải về.',
  'Tool loading is one of: {0}.': 'Cách tải công cụ phải là một trong: {0}.',
  "Google access has expired or been revoked. Reconnect Google in Settings → Connectors.":
    "Quyền truy cập Google đã hết hạn hoặc bị thu hồi. Hãy kết nối lại Google trong Cài đặt → Kết nối.",
  "Only Google API addresses can be called with the Google token.":
    "Token Google chỉ được dùng để gọi địa chỉ API của Google.",
  "Google has not given this app access to that. Reconnect Google in Settings → Connectors and allow it.":
    "Google chưa cho ứng dụng này quyền đó. Hãy kết nối lại Google trong Cài đặt → Kết nối và cho phép.",
  "That Google API is not switched on for this app. The deployment owner enables it in Google Cloud Console → APIs & Services ({0}).":
    "API Google đó chưa được bật cho ứng dụng này. Chủ bản triển khai bật nó trong Google Cloud Console → APIs & Services ({0}).",
  "Google answered HTTP {0}{1}.":
    "Google trả về HTTP {0}{1}.",
  "no Gemini key":
    "không có key Gemini",
  "not with Google data":
    "không dùng khi có dữ liệu Google",
  "Searching the indexed folders goes through a Google Gemini key, and this conversation holds data from the person's Google account, which is not sent there. Read the files with read_file instead, or search in a new conversation.":
    "Tìm trong các thư mục đã lập chỉ mục phải đi qua key Google Gemini, mà cuộc trò chuyện này có dữ liệu từ tài khoản Google của người dùng, thứ không được gửi tới đó. Hãy đọc tệp bằng read_file, hoặc tìm trong một cuộc trò chuyện mới.",
  "Pictures are made through a Google Gemini key, and this conversation holds data from the person's Google account, which is not sent there. Tell the user; a picture can be made in a new conversation.":
    "Ảnh được tạo qua key Google Gemini, mà cuộc trò chuyện này có dữ liệu từ tài khoản Google của người dùng, thứ không được gửi tới đó. Hãy báo người dùng; có thể tạo ảnh trong một cuộc trò chuyện mới.",
  "Google (Gemini grounding) returned HTTP {0}":
    "Google (Gemini grounding) trả về HTTP {0}",
  "action is search, read, send, draft, modify, trash or labels.":
    "action phải là search, read, send, draft, modify, trash hoặc labels.",
  "action is list, calendars, create, update, delete or free_busy.":
    "action phải là list, calendars, create, update, delete hoặc free_busy.",
  "action is search, read, create, upload, share, move, rename or trash.":
    "action phải là search, read, create, upload, share, move, rename hoặc trash.",
  "action is read, create, append or replace.":
    "action phải là read, create, append hoặc replace.",
  "values must be a list of rows, each a list of cells.":
    "values phải là danh sách các hàng, mỗi hàng là danh sách ô.",
  "action is info, read, write, append, create or clear.":
    "action phải là info, read, write, append, create hoặc clear.",
  "Question \"{0}\" needs options.":
    "Câu hỏi \"{0}\" cần có các lựa chọn.",
  "\"{0}\" is not a question type. Use text, paragraph, choice, checkbox, dropdown, scale, date or time.":
    "\"{0}\" không phải loại câu hỏi. Dùng text, paragraph, choice, checkbox, dropdown, scale, date hoặc time.",
  "action is create, get, responses or add_questions.":
    "action phải là create, get, responses hoặc add_questions.",
  "action is lists, list, add, complete or delete.":
    "action phải là lists, list, add, complete hoặc delete.",
  "action is search or list.":
    "action phải là search hoặc list.",
  "Give {0}.":
    "Hãy cung cấp {0}.",
  "Sends an email from your Gmail to {0}. It cannot be unsent.":
    "Gửi email từ Gmail của bạn tới {0}. Không thể thu hồi.",
  "Saves a draft in your Gmail. Nothing is sent.":
    "Lưu bản nháp trong Gmail của bạn. Chưa gửi gì cả.",
  "Moves an email to your Gmail trash.":
    "Chuyển một email vào thùng rác Gmail.",
  "Changes your Google Calendar and sends an invitation to {0}.":
    "Thay đổi Google Lịch và gửi lời mời tới {0}.",
  "Deletes an event from your Google Calendar.":
    "Xoá một sự kiện khỏi Google Lịch.",
  "Shares a Drive file with {0}.":
    "Chia sẻ một tệp Drive với {0}.",
  "Moves a file to your Google Drive trash.":
    "Chuyển một tệp vào thùng rác Google Drive.",
  "Deletes a task from Google Tasks.":
    "Xoá một việc khỏi Google Tasks.",
  "Changes something in your Google account ({0}: {1}).":
    "Thay đổi dữ liệu trong tài khoản Google của bạn ({0}: {1}).",
  "This conversation uses under 25% of the window, so there is nothing worth folding yet.":
    "Cuộc trò chuyện này dùng chưa tới 25% cửa sổ ngữ cảnh, nên chưa có gì đáng để nén.",
  "The provider stopped sending (stalled for {0}s).":
    "Nhà cung cấp ngừng gửi dữ liệu (treo {0} giây).",
  "Google Drive is not connected. Connect it in Settings → Connectors.":
    "Chưa kết nối Google Drive. Hãy kết nối trong Cài đặt → Kết nối.",
  "Edit {0} has nothing to find.":
    "Chỉnh sửa {0} không có đoạn cần tìm.",
  "Edit {0} did not match: its find text is not in the file. Read the source with read_generated_file and copy the text exactly.":
    "Chỉnh sửa {0} không khớp: đoạn cần tìm không có trong tệp. Đọc mã nguồn bằng read_generated_file và chép đúng từng ký tự.",
  "Edit {0} matches more than once. Include more of the surrounding text so it is unique.":
    "Chỉnh sửa {0} khớp nhiều hơn một chỗ. Thêm phần chữ xung quanh để nó là duy nhất.",
  "{0} has no stored source to edit. Pass the complete content instead.":
    "{0} không có mã nguồn đã lưu để sửa. Hãy gửi toàn bộ nội dung thay vào đó.",
  // The cloud computer (server/sandbox.js).
  'A file needs a path, e.g. "data/input.csv".': 'Tệp cần có đường dẫn, ví dụ "data/input.csv".',
  'Give a `command` to run, `python` for the live session, `files` to write, or a file to `download`.':
    'Hãy đưa `command` để chạy, `python` cho phiên Python đang mở, `files` để ghi, hoặc một tệp để `download`.',
  'Write at most {0} files per call.': 'Mỗi lần ghi tối đa {0} tệp.',
  '{0} is over 2MB; write it in parts or generate it inside the machine.':
    '{0} lớn hơn 2MB; hãy ghi từng phần hoặc tạo nó ngay trong máy.',
  'The cloud computer could not be started: {0}. On Vercel this needs OIDC enabled for the project; elsewhere VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID.':
    'Không khởi động được máy tính đám mây: {0}. Trên Vercel cần bật OIDC cho dự án; nơi khác cần VERCEL_TOKEN, VERCEL_TEAM_ID và VERCEL_PROJECT_ID.',
  // The cloud computer on E2B, with nothing to stand in (server/sandbox.js `unavailableError`).
  "The cloud computer could not be started: E2B did not accept this deployment's key (E2B_API_KEY). Tell the user plainly; the owner has to check the key.":
    'Không khởi động được máy tính đám mây: E2B không chấp nhận khoá của bản triển khai này (E2B_API_KEY). Hãy nói rõ với người dùng; chủ bản triển khai cần kiểm tra lại khoá.',
  "The cloud computer could not be started: this server could not load its E2B library. Tell the user plainly; the owner has to check the deployment's logs.":
    'Không khởi động được máy tính đám mây: máy chủ này không nạp được thư viện E2B. Hãy nói rõ với người dùng; chủ bản triển khai cần xem log của bản triển khai.',
  'The cloud computer could not be started: E2B is not answering right now. Try again in a few minutes; tell the user it is busy, not broken.':
    'Không khởi động được máy tính đám mây: E2B hiện không phản hồi. Hãy thử lại sau vài phút; nói với người dùng là dịch vụ đang bận, không phải bị hỏng.',
  '{0} does not exist in the machine — check the path with `ls`.': '{0} không có trong máy — kiểm tra đường dẫn bằng `ls`.',
  '{0} is over 10MB, too large to hand over.': '{0} lớn hơn 10MB, quá lớn để gửi.',
  '{0} is not a kind of file the conversation can show (PDF, image, Office, text, CSV, JSON). Convert it first.':
    '{0} không phải loại tệp hội thoại hiển thị được (PDF, ảnh, Office, văn bản, CSV, JSON). Hãy chuyển đổi trước.',
  'Reasoning effort is one of: {0}.': 'Mức suy luận phải là một trong: {0}.',
  'This link does not exist, or was taken back.': 'Link này không tồn tại hoặc đã bị thu hồi.',
  '{0} should be a plain string, but got an object. Send the text itself, e.g. "…", not { "task": "…" }.':
    '{0} phải là chuỗi văn bản thường, nhưng nhận được một object. Hãy gửi chính đoạn văn bản, ví dụ "…", không phải { "task": "…" }.',
  // Vision for models that cannot see (server/vision.js, look_at).
  'There is no file {0} in this account.': 'Không có tệp {0} trong tài khoản này.',
  // A picture read_file found (server/tools/execute.js, readPicture).
  'the copy to look at was not stored': 'bản sao để xem chưa được lưu',
  'It is {0}×{1} — too many pixels to open safely. Make a smaller copy and read that.':
    'Ảnh này {0}×{1} — quá nhiều điểm ảnh để mở an toàn. Hãy tạo bản nhỏ hơn rồi đọc bản đó.',
  // look_at by path, on the cloud computer (server/tools/cloud.js, server/sandbox.js).
  "This account has no cloud computer, so there is nothing at that path. For a file on the user's own computer, use read_file.":
    'Tài khoản này không có máy cloud, nên đường dẫn đó không có gì. Với tệp trên máy của người dùng, hãy dùng read_file.',
  "{0} is not on the cloud computer — check the path with ls. For a file on the user's own computer, use read_file.":
    '{0} không có trên máy cloud — kiểm tra đường dẫn bằng ls. Với tệp trên máy của người dùng, hãy dùng read_file.',
  '{0} is not an image or a PDF — read it with sandbox_run instead.': '{0} không phải hình ảnh hay PDF — hãy đọc bằng sandbox_run.',
  '{0} is over {1}MB, too large to look at whole.': '{0} lớn hơn {1}MB, quá lớn để xem trọn.',
  '{0} is not a picture or a PDF — read it with read_generated_file or as text instead.':
    '{0} không phải hình ảnh hay PDF — hãy đọc bằng read_generated_file hoặc dạng văn bản.',
  'That address is {0}, not an image or a PDF — use web_fetch for a page.':
    'Địa chỉ đó là {0}, không phải hình ảnh hay PDF — dùng web_fetch cho trang web.',
  'That file is over 12MB, too large to look at.': 'Tệp đó lớn hơn 12MB, quá lớn để xem.',
  'Give a `file_id` (an attachment, a made file or a step screenshot) or a `url` of an image or PDF.':
    'Hãy đưa `file_id` (tệp đính kèm, tệp đã tạo hoặc ảnh chụp màn hình của một bước) hoặc `url` của ảnh hay PDF.',
  'it answered with nothing': 'model không trả lời gì',
  'took more than {0}s': 'mất hơn {0} giây',
  'The cloud computer took more than {0}s to hand over {1}, so it was not read. Try once more; if it is slow again, make a smaller copy first.':
    'Máy tính đám mây mất hơn {0} giây để đưa ra {1}, nên chưa đọc được. Hãy thử lại một lần; nếu vẫn chậm, hãy tạo một bản nhỏ hơn trước.',
  stopped: 'đã dừng',
  'None of the models that can see could read it — {0}': 'Không model thị giác nào đọc được — {0}',
  // Share links.
  'Only something the assistant made can be shared by link. Uploaded files stay private.':
    'Chỉ những gì trợ lý tạo ra mới chia sẻ được bằng link. Tệp tải lên luôn được giữ riêng tư.',
  '{0} stays on the cloud computer, being too large to keep in the conversation, so it cannot have a public link. It downloads from its card.':
    '{0} vẫn nằm trên máy tính đám mây vì quá lớn để giữ trong cuộc trò chuyện, nên không có link công khai. Hãy tải xuống từ thẻ của tệp.',
  'Give the `file_id` of a file you made — create_file returns it.': 'Hãy đưa `file_id` của tệp đã tạo — create_file trả về giá trị này.',
  'There is no file {0} made in this account.': 'Không có tệp {0} nào được tạo trong tài khoản này.',
  'That picture is too large to read for text. Crop it to the part that matters, or send a smaller copy.':
    'Ảnh này quá lớn để đọc chữ. Hãy cắt lấy phần cần đọc, hoặc gửi bản nhỏ hơn.',
  'That pattern took too long on this text: it backtracks without end (nested repeats such as (a+)+). Simplify it.':
    'Mẫu này chạy quá lâu trên đoạn văn bản: nó quay lui không dứt (lặp lồng nhau kiểu (a+)+). Hãy đơn giản hoá mẫu.',
  'This command on the cloud computer looks like it sends data out or destroys something.':
    'Lệnh này trên máy tính đám mây có vẻ gửi dữ liệu ra ngoài hoặc xoá thứ gì đó.',
  'This Python on the cloud computer looks like it sends data out, or runs a command that destroys something.':
    'Đoạn Python này trên máy tính đám mây có vẻ gửi dữ liệu ra ngoài, hoặc chạy một lệnh xoá thứ gì đó.',
  "Writes a file on the cloud computer that, run, would send data out, destroy something, use root, or reach the browser's sign-ins.":
    'Ghi một tệp trên máy tính đám mây mà khi chạy sẽ gửi dữ liệu ra ngoài, xoá thứ gì đó, dùng quyền root, hoặc chạm tới các phiên đăng nhập của trình duyệt.',
  'The cloud computer is still busy with that, or it took longer than allowed; it was not run a second time. Look at the page (or ask the session) before trying again.':
    'Máy tính đám mây vẫn đang bận việc đó, hoặc việc đó lâu hơn mức cho phép; nó không bị chạy lần thứ hai. Hãy xem lại trang (hoặc hỏi phiên Python) trước khi thử lại.',
  "Runs as root on the cloud computer, where it can reach everything on it, including the cloud browser's sign-ins.":
    'Chạy với quyền root trên máy tính đám mây — tới được mọi thứ trên máy, kể cả phiên đăng nhập của trình duyệt đám mây.',
  "Touches the cloud browser's saved sign-ins or a login script on the cloud computer.":
    'Chạm vào phiên đăng nhập đã lưu của trình duyệt đám mây hoặc tệp khởi động shell trên máy tính đám mây.',
  'Makes this file public: anyone with the link can open it without signing in.':
    'Công khai tệp này: ai có link đều mở được mà không cần đăng nhập.',
  // Scatter charts.
  'Give `data.series` — at least one { name, points: [[x, y], …] }.':
    'Hãy đưa `data.series` — ít nhất một { name, points: [[x, y], …] }.',
  'Series "{0}" needs `points`: a list of [x, y] pairs.': 'Chuỗi "{0}" cần `points`: danh sách các cặp [x, y].',
  'Series "{0}" has a point that is not two numbers: {1}.': 'Chuỗi "{0}" có một điểm không phải hai con số: {1}.',
  'That is {0} points; a scatter chart draws up to {1}.': 'Có {0} điểm; biểu đồ phân tán vẽ tối đa {1}.',
  // Image search and sports.
  'Say what to look for, e.g. "Ha Long Bay at sunset".': 'Hãy nói cần tìm gì, ví dụ "Vịnh Hạ Long lúc hoàng hôn".',
  'TheSportsDB is rate-limiting (30 requests a minute on the free key). Try again shortly.':
    'TheSportsDB đang giới hạn tần suất (30 yêu cầu mỗi phút với key miễn phí). Thử lại sau ít phút.',
  'TheSportsDB returned HTTP {0}.': 'TheSportsDB trả về HTTP {0}.',
  'No team called "{0}" was found on TheSportsDB. Try its English name, e.g. "Manchester United".':
    'Không tìm thấy đội "{0}" trên TheSportsDB. Thử tên tiếng Anh, ví dụ "Manchester United".',
  '"{0}" is not a league this knows by name. Use one of: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, Europa League, V.League, Eredivisie, MLS, NBA, NFL, MLB, NHL — or its TheSportsDB id.':
    '"{0}" không phải giải đấu được biết theo tên. Dùng một trong: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, Europa League, V.League, Eredivisie, MLS, NBA, NFL, MLB, NHL — hoặc id TheSportsDB.',
  'No league with id {0} on TheSportsDB.': 'Không có giải đấu id {0} trên TheSportsDB.',
  'date is YYYY-MM-DD.': 'date có dạng YYYY-MM-DD.',
  'No player called "{0}" was found.': 'Không tìm thấy cầu thủ "{0}".',
  'op is team, league, day or player.': 'op là team, league, day hoặc player.',
  "Pass content (the whole new file, or the next part with append) or edits (the parts that change).":
    "Hãy gửi content (toàn bộ tệp mới, hoặc phần tiếp theo kèm append) hoặc edits (chỉ những phần thay đổi).",

  // ── memory, privacy, your data, incognito ──
  "Enter the current code from your authenticator app.":
    "Nhập mã hiện tại trong ứng dụng xác thực của bạn.",
  "the page took too long to load":
    "trang tải quá lâu",
  "A note cannot be empty. Delete it instead.":
    "Ghi chú không được để trống. Hãy xoá nó thay vì vậy.",
  "A note can be at most {0} characters.":
    "Một ghi chú dài tối đa {0} ký tự.",
  "Paste the text to import.":
    "Hãy dán văn bản cần nhập.",
  "Nothing to import was sent.":
    "Không có gì được gửi lên để nhập.",
  "Send at most 50 conversations at a time.":
    "Mỗi lần chỉ gửi tối đa 50 cuộc trò chuyện.",
  "You are the only administrator. Make someone else an administrator in Settings → People before deleting your account.":
    "Bạn là quản trị viên duy nhất. Hãy đặt người khác làm quản trị viên trong Cài đặt → Mọi người trước khi xoá tài khoản.",
  "the download was cancelled":
    "đã huỷ tải xuống",
  "An incognito conversation cannot be shared.":
    "Cuộc trò chuyện ẩn danh không thể được chia sẻ.",
  "An incognito conversation cannot be part of a project.":
    "Cuộc trò chuyện ẩn danh không thể thuộc một dự án.",
  "Keep conversations for one of: {0} days (0 keeps everything).":
    "Thời gian giữ cuộc trò chuyện phải là một trong: {0} ngày (0 là giữ tất cả).",
  "Provider privacy is one of: {0}.":
    "Quyền riêng tư với nhà cung cấp phải là một trong: {0}.",
  "Memory is switched off for this account (Settings → Memory), so nothing is saved or read. Tell the user if it matters.":
    "Bộ nhớ đang tắt cho tài khoản này (Cài đặt → Bộ nhớ), nên không lưu và không đọc gì. Hãy báo người dùng nếu điều đó quan trọng.",
  "This is an incognito conversation: nothing in it is remembered, and saved notes are not used here.":
    "Đây là cuộc trò chuyện ẩn danh: không ghi nhớ gì từ nó, và các ghi chú đã lưu không được dùng ở đây.",
  "That note would be {0} characters; the limit is {1}, because every note is read into every conversation. Keep the facts that will matter later and drop the rest, or split it by subject.":
    "Ghi chú đó sẽ dài {0} ký tự; giới hạn là {1}, vì mọi ghi chú đều được đọc vào mọi cuộc trò chuyện. Hãy giữ những điều sẽ cần sau này và bỏ phần còn lại, hoặc tách theo chủ đề.",
  "Say what to look for.":
    "Hãy nói cần tìm gì.",
  'Connector search is switched off for this account (Settings → Capabilities). Say which service would help instead.':
    'Tìm kết nối đang tắt cho tài khoản này (Cài đặt → Khả năng). Hãy nói dịch vụ nào sẽ giúp được thay vào đó.',
  "Searching earlier conversations is switched off for this account (Settings → Memory). Say so if it matters.":
    "Tìm trong các cuộc trò chuyện trước đang tắt cho tài khoản này (Cài đặt → Bộ nhớ). Hãy nói rõ nếu điều đó quan trọng.",
  "This is an incognito conversation, so earlier conversations are not searched from it.":
    "Đây là cuộc trò chuyện ẩn danh, nên không tìm trong các cuộc trò chuyện trước từ đây.",
  "No provider serving this model promises not to store or train on what you send, so the strict privacy setting kept it from running. Pick another model, or set Provider privacy back to Standard in Settings → Memory.":
    "Không nhà cung cấp nào phục vụ mô hình này cam kết không lưu hay huấn luyện trên nội dung bạn gửi, nên chế độ riêng tư nghiêm ngặt đã chặn nó. Hãy chọn mô hình khác, hoặc đặt Quyền riêng tư với nhà cung cấp về Tiêu chuẩn trong Cài đặt → Bộ nhớ.",
  "This conversation holds data from your Google account, and {0} may keep what it is sent or learn from it, so it was not sent there. Pick a model on OpenRouter — Claude and GPT are there too.":
    "Cuộc trò chuyện này có dữ liệu từ tài khoản Google của bạn, mà {0} có thể lưu lại hoặc dùng để học, nên nó không được gửi tới đó. Hãy chọn một mô hình trên OpenRouter — ở đó cũng có Claude và GPT.",
  "This conversation holds data from your Google account, so it goes only to providers that neither keep it nor train on it, and none serving {0} promises that. Pick another model.":
    "Cuộc trò chuyện này có dữ liệu từ tài khoản Google của bạn, nên chỉ được gửi tới nhà cung cấp không lưu và không huấn luyện trên nó — và không nhà cung cấp nào phục vụ {0} cam kết điều đó. Hãy chọn mô hình khác.",
  "Not saved: the note contains {0}. Notes never hold identity, passport, tax, bank or card numbers, criminal records or immigration status — not even when the user asks, because a note is read into every future conversation. Save the useful part without that detail if there is one, and tell the user plainly what was left out and why.":
    "Không lưu: ghi chú chứa {0}. Ghi chú không bao giờ chứa số căn cước, hộ chiếu, mã số thuế, tài khoản ngân hàng hay số thẻ, tiền án hoặc tình trạng cư trú — kể cả khi người dùng yêu cầu, vì ghi chú được đọc vào mọi cuộc trò chuyện sau này. Hãy lưu phần hữu ích mà không có chi tiết đó nếu có, và nói rõ với người dùng phần nào bị bỏ và vì sao.",
  "Not saved: the note is about {0}, a sensitive topic, and remembering sensitive topics is switched off for this account. Tell the user that, and that they can switch it on in Settings → Memory. Do not save it another way.":
    "Không lưu: ghi chú nói về {0}, một chủ đề nhạy cảm, và việc ghi nhớ chủ đề nhạy cảm đang tắt cho tài khoản này. Hãy báo người dùng điều đó, và rằng họ có thể bật trong Cài đặt → Bộ nhớ. Đừng lưu theo cách khác.",
  "a payment card number":
    "số thẻ thanh toán",
  "a bank account number (IBAN)":
    "số tài khoản ngân hàng (IBAN)",
  "a social security number":
    "số an sinh xã hội",
  "an identity document number":
    "số giấy tờ tuỳ thân",
  "a bank or card number":
    "số tài khoản ngân hàng hoặc số thẻ",
  "a criminal record":
    "tiền án",
  "immigration status":
    "tình trạng cư trú",
  "health":
    "sức khoẻ",
  "religion":
    "tôn giáo",
  "politics":
    "chính trị",
  "ethnicity":
    "dân tộc",
  "sexuality":
    "xu hướng tính dục",
  "That file would come to {0}, over the {1} limit.":
    "Tệp đó sẽ thành {0}, vượt giới hạn {1}.",
  "This cloud computer has {0} MiB of memory, too little to start a browser. Use web_fetch to read a page, and tell the user the browser is not available on this computer.":
    "Máy cloud này chỉ có {0} MiB bộ nhớ, quá ít để khởi động trình duyệt. Hãy dùng web_fetch để đọc trang và báo cho người dùng rằng trình duyệt không dùng được trên máy này.",
  "The browser could not start on the cloud computer, so no page opened. Trying the same again will not help: use web_fetch for a page, or playwright in sandbox_run, and tell the user the browser is not available right now.":
    "Trình duyệt không khởi động được trên máy cloud nên chưa mở được trang nào. Thử lại y hệt cũng không giúp gì: hãy dùng web_fetch để đọc trang, hoặc playwright trong sandbox_run, và báo cho người dùng rằng lúc này trình duyệt không dùng được.",
  "This machine is nobody's, so it keeps no checkpoints.":
    "Máy này không thuộc tài khoản nào nên không lưu điểm khôi phục.",
  "There is no checkpoint {0} on this computer.":
    "Máy này không có điểm khôi phục {0}.",
  "packing ended with {0}":
    "đóng gói kết thúc với mã {0}",
  "the home folder packs to {0} bytes":
    "thư mục home đóng gói được {0} byte",
  "unpacking ended with {0}":
    "giải nén kết thúc với mã {0}",
  "A terminal's name is letters, digits, - and _.":
    "Tên terminal chỉ gồm chữ, số, - và _.",
  "Say what to type, in `text`.":
    "Hãy cho biết cần gõ gì, trong `text`.",
  "`keys` names special keys, such as C-c, Enter, Up, Tab or Escape.":
    "`keys` là tên các phím đặc biệt như C-c, Enter, Up, Tab hoặc Escape.",
  "A terminal's action is start, send, keys, read, list or stop.":
    "Hành động của terminal là start, send, keys, read, list hoặc stop.",
  "That workbook has no workbook part, so it may be corrupt.":
    "Tệp Excel đó thiếu phần workbook nên có thể đã hỏng.",
  "There is no sheet called \"{0}\". The sheets are: {1}.":
    "Không có sheet nào tên \"{0}\". Các sheet là: {1}.",
  "That worksheet has no sheetData, so it may be corrupt.":
    "Sheet đó thiếu sheetData nên có thể đã hỏng.",
  "Say which cells to change, in `cells`.":
    "Hãy cho biết cần sửa ô nào, trong `cells`.",
  "Change at most {0} cells in one call.":
    "Mỗi lần chỉ sửa tối đa {0} ô.",
  "No sheet in that workbook could be found.":
    "Không tìm thấy sheet nào trong tệp Excel đó.",
  "Cell {0} ({1}) does not say which sheet. The sheets are: {2}.":
    "Ô thứ {0} ({1}) chưa nói thuộc sheet nào. Các sheet là: {2}.",
  "\"{0}\" is not a cell address like K18.":
    "\"{0}\" không phải địa chỉ ô, ví dụ K18.",
  "{0} would hold {1} characters; a cell holds {2}.":
    "{0} sẽ chứa {1} ký tự, trong khi một ô chỉ chứa được {2}.",
  "{0} on \"{1}\" is inside the merged cells {2}; only {3} shows anything there. Change that one.":
    "{0} ở \"{1}\" nằm trong vùng gộp ô {2}; chỉ {3} mới hiện nội dung ở đó. Hãy sửa ô đó.",
  "{0} on \"{1}\" starts a formula other cells share, so it cannot be changed on its own. Do this one with sandbox_run and openpyxl.":
    "{0} ở \"{1}\" là ô bắt đầu của công thức dùng chung với các ô khác nên không sửa riêng được. Hãy dùng sandbox_run và openpyxl cho ô này.",
  "\"{0}\" is not a cell address like K17.":
    "\"{0}\" không phải địa chỉ ô, ví dụ K17.",
  "Changing \"{0}\" would also have changed {1}, so nothing was saved.":
    "Sửa \"{0}\" sẽ làm thay đổi cả {1} nên chưa có gì được lưu.",
  "Changing \"{0}\" would have lost {1}, so nothing was saved.":
    "Sửa \"{0}\" sẽ làm mất {1} nên chưa có gì được lưu.",
  "That workbook has no list of sheets, so it may be corrupt.":
    "Tệp Excel đó thiếu danh sách sheet nên có thể đã hỏng.",
  "Rebuilding the file would have changed {0}, so nothing was saved.":
    "Dựng lại tệp sẽ làm thay đổi {0} nên chưa có gì được lưu.",
  "Say what to change, in `edits`.":
    "Hãy cho biết cần sửa gì, trong `edits`.",
  "Make at most {0} changes in one call.":
    "Mỗi lần chỉ sửa tối đa {0} chỗ.",
  "That file has no {0} part, so it may be corrupt.":
    "Tệp đó thiếu phần {0} nên có thể đã hỏng.",
  "Change {0} has nothing to find.":
    "Thay đổi thứ {0} chưa có nội dung cần tìm.",
  "There is no slide {0}.":
    "Không có trang chiếu {0}.",
  "Change {0} did not match: \"{1}\" is not in the file. Read it with read_generated_file and copy the words exactly.":
    "Thay đổi thứ {0} không khớp: \"{1}\" không có trong tệp. Hãy đọc tệp bằng read_generated_file và chép đúng nguyên văn.",
  "Change {0} matches {1} places: \"{2}\". Include more of the words around it, or say `all`.":
    "Thay đổi thứ {0} khớp {1} chỗ: \"{2}\". Hãy lấy thêm chữ xung quanh, hoặc dùng `all`.",
  "\"{0}\" is not a range like A1:K40.":
    "\"{0}\" không phải một vùng ô, ví dụ A1:K40.",
  "No such job: {0}":
    "Không có công việc: {0}",
  "Bring at most {0} files per call.":
    "Mỗi lần chỉ đưa tối đa {0} tệp lên máy.",
  "expose_port is a port from 1024 to 65535.":
    "expose_port phải là cổng từ 1024 đến 65535.",
  "{0} came from Google Drive, which stays off the cloud computer. Read it with read_file or look_at instead.":
    "{0} đến từ Google Drive nên không được đưa lên máy cloud. Hãy đọc bằng read_file hoặc look_at.",
  "{0} is on the cloud computer already, at {1}.":
    "{0} đã có trên máy cloud, ở {1}.",
  "This computer cannot keep checkpoints.":
    "Máy này không lưu được điểm khôi phục.",
  "A checkpoint's action is save, list or restore.":
    "Hành động của điểm khôi phục là save, list hoặc restore.",
  "{0} is a workbook: say which cells to change, in `cells`. read_generated_file with this id lists its sheets and reads them by address.":
    "{0} là tệp Excel: hãy cho biết cần sửa ô nào, trong `cells`. read_generated_file với id này liệt kê các sheet và đọc theo địa chỉ ô.",
  "Say what to change in {0}, in `edits`.":
    "Hãy cho biết cần sửa gì trong {0}, trong `edits`.",
  "{0} cannot be changed this way. A program can: sandbox_run with bring and this id puts it on the cloud computer, and download with replaces and this id gives it back as the same file.":
    "Không sửa {0} theo cách này được. Một chương trình thì làm được: sandbox_run với bring và id này đưa tệp lên máy cloud, còn download với replaces và id này trả lại đúng tệp đó.",
  "{0} is on the cloud computer at {1}: change it there with sandbox_run.":
    "{0} đang ở trên máy cloud tại {1}: hãy sửa ở đó bằng sandbox_run.",
  "{0} was uploaded by the user, not written by you, so it cannot be rewritten whole, which would lose what is in it. Change it where it stands: `cells` for a workbook, `edits` for anything else.":
    "{0} là tệp người dùng gửi, không phải bạn viết, nên không thể viết lại toàn bộ vì sẽ mất nội dung bên trong. Hãy sửa ngay trên tệp: `cells` cho tệp Excel, `edits` cho các loại khác.",
  "{0} was uploaded, so it has no source to read back. For how it looks, use look_at.":
    "{0} là tệp tải lên nên không có nguồn để đọc lại. Muốn xem hình thức của tệp, hãy dùng look_at.",
  "Gives port {0} of the cloud computer a public address: anyone who has it can reach what is listening there.":
    "Cấp địa chỉ công khai cho cổng {0} của máy cloud: ai có địa chỉ đó đều truy cập được thứ đang chạy ở cổng này.",
  "Puts the cloud computer back to a saved checkpoint: everything since then on it is gone.":
    "Đưa máy cloud về điểm khôi phục đã lưu: mọi thứ phát sinh sau đó trên máy sẽ mất.",
  "That file is no longer on the cloud computer.":
    "Tệp đó không còn trên máy cloud.",
  "No air quality reading for {0}.":
    "Không có số đo chất lượng không khí cho {0}.",
  "No sunrise time for {0}.":
    "Không có giờ mặt trời mọc cho {0}.",
  "No public holidays are listed for {0} in {1}.":
    "Không có danh sách ngày lễ của {0} năm {1}.",
  "Say which country, e.g. Vietnam or VN.":
    "Hãy cho biết quốc gia nào, ví dụ Vietnam hoặc VN.",
  "No country called \"{0}\" was found. Try its English name.":
    "Không tìm thấy quốc gia \"{0}\". Hãy thử tên tiếng Anh.",
  "Say which place or time zone.":
    "Hãy cho biết địa điểm hoặc múi giờ.",
  "Say the clock time as HH:MM, or YYYY-MM-DD HH:MM.":
    "Hãy ghi giờ theo dạng HH:MM, hoặc YYYY-MM-DD HH:MM.",
  "kind is one of: time, convert_time, weather, forecast, air_quality, sun, moon, exchange_rate, holidays, country, earthquakes, place.":
    "kind là một trong: time, convert_time, weather, forecast, air_quality, sun, moon, exchange_rate, holidays, country, earthquakes, place.",
  "Wikidata has nothing matching \"{0}\".":
    "Wikidata không có mục nào khớp \"{0}\".",
  "Wiktionary has no entry for \"{0}\".":
    "Wiktionary không có mục từ \"{0}\".",
  "Open Library has no book matching \"{0}\".":
    "Open Library không có sách nào khớp \"{0}\".",
  "Crossref has no paper matching \"{0}\".":
    "Crossref không có bài báo nào khớp \"{0}\".",
  "arXiv has no paper matching \"{0}\".":
    "arXiv không có bài báo nào khớp \"{0}\".",
  "There is no reference called {0}: wikipedia, wikidata, wiktionary, openlibrary, crossref or arxiv.":
    "Không có nguồn tra cứu tên {0}: chỉ có wikipedia, wikidata, wiktionary, openlibrary, crossref hoặc arxiv.",
  "This account has used today's LibreOffice drawings. The ordinary preview still works.":
    "Tài khoản này đã dùng hết lượt dựng bằng LibreOffice hôm nay. Bản xem thường vẫn dùng được.",
  "LibreOffice is not available right now. The ordinary preview still works.":
    "Lúc này LibreOffice chưa dùng được. Bản xem thường vẫn dùng được.",
  "LibreOffice could not draw that file. The ordinary preview still works.":
    "LibreOffice không dựng được tệp đó. Bản xem thường vẫn dùng được.",
  "LibreOffice's drawing of that file is too large to keep. The ordinary preview still works.":
    "Bản dựng của LibreOffice quá lớn để lưu. Bản xem thường vẫn dùng được.",
  "That workbook has no sheet to show.":
    "Tệp Excel đó không có sheet nào để hiện.",
  "That is not a Word or PowerPoint file this can draw.":
    "Đây không phải tệp Word hay PowerPoint có thể vẽ được.",
  "That file could not be read: {0}":
    "Không đọc được tệp đó: {0}",
  /* ── the Bot page (server/bots/, server/routes/bots.js; 2026-11-09) ── */
  'This is a group chat\'s log. Send your message in the group on the Bot page.': 'Đây là nhật ký của một nhóm chat. Hãy gửi tin nhắn trong nhóm ở trang Bot.',
  'Send this in the group chat on the Bot page.': 'Hãy gửi tin này trong nhóm chat ở trang Bot.',
  'An entry needs some words.': 'Một mục cần có nội dung.',
  'One sentence here is longer than {0} characters, the most an entry holds. Say it more briefly.': 'Có một câu ở đây dài hơn {0} ký tự, mức tối đa của một mục. Hãy nói ngắn gọn hơn.',
  'That looks like a key, token or password, which memory never keeps.': 'Nội dung này giống một khoá, token hoặc mật khẩu, mà bộ nhớ thì không bao giờ giữ những thứ đó.',
  'This memory is full ({0} entries). Forget one that is no longer true first.': 'Bộ nhớ này đã đầy ({0} mục). Hãy quên bớt một mục không còn đúng trước.',
  'No such bot or group.': 'Không có bot hoặc nhóm này.',
  'Say which entry.': 'Hãy nói mục nào.',
  'No entry holds those words.': 'Không mục nào có những chữ đó.',
  '{0} entries hold those words; quote more of the one you mean.': 'Có {0} mục chứa những chữ đó; hãy trích nhiều hơn của mục bạn muốn nói.',
  'A replacement is one fact, at most {0} characters. Save the rest as new entries.': 'Mục thay thế chỉ ghi một điều, tối đa {0} ký tự. Hãy lưu phần còn lại thành mục mới.',
  'The person pinned that entry; only they can unpin it.': 'Người dùng đã ghim mục này; chỉ họ mới bỏ ghim được.',
  'Say what to change: text or pinned.': 'Hãy nói cần đổi gì: nội dung hoặc ghim.',
  'A memory review is off, or every 20 or 40 turns.': 'Ôn lại bộ nhớ là tắt, hoặc mỗi 20 hay 40 lượt.',
  'No such group chat.': 'Không có nhóm chat này.',
  '{0} is at most {1} characters.': '{0} tối đa {1} ký tự.',
  'A role': 'Vai trò',
  'Instructions': 'Hướng dẫn',
  'A group name': 'Tên nhóm',
  'That is not a model id.': 'Đó không phải mã mô hình.',
  'An account keeps at most {0} bots. Delete one first.': 'Mỗi tài khoản có tối đa {0} bot. Hãy xoá bớt một bot trước.',
  'There is already a bot called {0}.': 'Đã có một bot tên {0}.',
  'That is not one of the creatures.': 'Đó không phải một trong các linh vật.',
  'No such bot.': 'Không có bot này.',
  'A group chat needs a name.': 'Nhóm chat cần có tên.',
  'An account keeps at most {0} group chats.': 'Mỗi tài khoản có tối đa {0} nhóm chat.',
  'There is already a group called {0}.': 'Đã có một nhóm tên {0}.',
  'A group chat needs at least one of your bots in it.': 'Nhóm chat cần có ít nhất một bot của bạn.',
  'A group chat holds at most {0} bots.': 'Mỗi nhóm chat có tối đa {0} bot.',
  'The admin has to be one of the group\'s bots.': 'Quản trị phải là một bot trong nhóm.',
  'Chief runs the team, so it can be changed but not deleted.': 'Chief điều hành đội nên chỉ sửa được, không xoá được.',
  'Not found.': 'Không tìm thấy.',
  'No such entry.': 'Không có mục này.',
  'Type something to send to the group.': 'Hãy gõ gì đó để gửi vào nhóm.',
  'That message is too long for a group chat.': 'Tin nhắn này quá dài cho một nhóm chat.',
  'This group is already answering. Wait for it, or stop it.': 'Nhóm này đang trả lời. Hãy đợi, hoặc dừng nó lại.',
  'userId and groupId are needed.': 'Cần userId và groupId.',
  'This bot is answering. Stop it first, then reset.': 'Bot này đang trả lời. Hãy dừng nó trước, rồi đặt lại.',
  'This group is answering. Stop it first, then reset.': 'Nhóm này đang trả lời. Hãy dừng nó trước, rồi đặt lại.',
  'There is nothing waiting to carry on.': 'Không có việc gì đang chờ để làm tiếp.',
  'That is not a version of the suggestion.': 'Đây không phải phiên bản của gợi ý mô hình.',
  'The group could not answer. Try again in a moment.': 'Nhóm chưa trả lời được. Thử lại sau giây lát.',
  'Give a range: from and to.': 'Hãy chọn khoảng thời gian: từ và đến.',
  'A range is at most 400 days.': 'Một khoảng thời gian tối đa 400 ngày.',
  'The unit is hour, day, week or month.': 'Đơn vị là giờ, ngày, tuần hoặc tháng.',
  'That is not a time zone.': 'Đó không phải một múi giờ.',
  'A bot needs a name.': 'Bot cần có tên.',
  'A bot\'s name is at most 40 characters.': 'Tên bot tối đa 40 ký tự.',
  'A bot\'s name cannot contain @, `, < or > or a line break.': 'Tên bot không được có @, `, <, > hoặc xuống dòng.',
  'That word stands for the user or for everyone in a chat, so it cannot be a bot\'s name.': 'Từ này chỉ người dùng hoặc mọi người trong cuộc trò chuyện, nên không đặt làm tên bot được.',

  // Market data (server/finance, 2026-11-10).
  'kind is one of: {0}.': 'kind là một trong: {0}.',
  'Name a symbol — e.g. FPT, VNM, SHS, VNINDEX for Vietnam; AAPL, ^GSPC, gold; BTC, ETH for crypto.': 'Hãy nêu một mã — ví dụ FPT, VNM, SHS, VNINDEX cho Việt Nam; AAPL, ^GSPC, vàng; BTC, ETH cho tiền mã hoá.',
  '{0} is offered for {1} — not for {2}.{3}': '{0} có cho {1} — không có cho {2}.{3}',
  'Vietcap lists no covered warrants or index futures{0}.': 'Vietcap không có chứng quyền hay hợp đồng tương lai chỉ số nào{0}.',
  'macro needs an indicator: gdp, cpi (inflation), unemployment, rate, 10y, population — or a World Bank or FRED code.': 'macro cần một chỉ tiêu: gdp, cpi (lạm phát), unemployment (thất nghiệp), rate (lãi suất), 10y, population (dân số) — hoặc một mã của Ngân hàng Thế giới hay FRED.',
  'There is no rate from {0} to {1} today: {2}': 'Hôm nay không có tỷ giá từ {0} sang {1}: {2}',
  // The Bot page's team features (spec B, 2026-11-11).
  '{0} is done — see the group.': '{0} đã xong — xem trong nhóm.',
  'That is not a team file: it does not read as JSON.': 'Đây không phải tệp nhóm bot: không đọc được dưới dạng JSON.',
  'That is not a team file.': 'Đây không phải tệp nhóm bot.',
  'This app reads {0} files; that one is {1}.': 'Ứng dụng này đọc tệp {0}; tệp đó là {1}.',
  'That file has no bots and no groups in it.': 'Tệp đó không có bot hay nhóm nào.',
  'A team file holds at most {0} bots and {1} groups.': 'Một tệp nhóm bot chứa tối đa {0} bot và {1} nhóm.',
  'None of its members came in.': 'Không thành viên nào của nhóm này được nhập.',
  'It could not be added.': 'Không thêm được mục này.',
  'Chief runs the team, so it is never paused.': 'Chief điều hành cả đội nên không bao giờ bị tạm dừng.',
  'That is not one of the colours.': 'Đó không phải một trong các màu có sẵn.',
  'Chief is one of a kind: make a new bot instead.': 'Chief là duy nhất: hãy tạo một bot mới thay vì nhân bản.',
  'Ask something.': 'Hãy hỏi một điều gì đó.',
  '{0} is paused. Resume it on the Bot page to talk to it.': '{0} đang tạm dừng. Hãy bật lại ở trang Bot để trò chuyện.',
  'A question aside is at most {0} characters.': 'Câu hỏi riêng dài tối đa {0} ký tự.',
  'No model can answer right now. Pick another in the top bar.': 'Hiện không mô hình nào trả lời được. Hãy chọn mô hình khác ở thanh trên cùng.',
  'The model did not answer: {0}': 'Mô hình không trả lời: {0}',
  'The model gave no answer. Try again, or another model.': 'Mô hình không đưa ra câu trả lời. Hãy thử lại, hoặc dùng mô hình khác.',
};
