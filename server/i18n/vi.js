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
  'Supadata could not read that video: {0}': 'Supadata không đọc được video đó: {0}',
  'Supadata queued video {0} as a background job rather than answering, which this tool cannot wait for. Try a shorter video.':
    'Supadata xếp video {0} vào hàng đợi xử lý nền thay vì trả lời ngay, và công cụ này không chờ được. Hãy thử video ngắn hơn.',
  'Supadata returned no captions for video {0}. The video probably has none — say so rather than retrying.':
    'Supadata không trả về phụ đề nào cho video {0}. Nhiều khả năng video không có phụ đề — hãy nói thẳng ra thay vì thử lại.',
  'This conversation is already running somewhere else. Wait for it, or stop it there.':
    'Cuộc trò chuyện này đang chạy ở nơi khác. Hãy đợi, hoặc dừng nó ở đó.',
  'Type something, or attach a file.': 'Hãy gõ gì đó, hoặc đính kèm một tệp.',
  'This conversation is running. Stop it first.': 'Cuộc trò chuyện này đang chạy. Hãy dừng nó trước.',
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
  'A skill needs instructions — the actual procedure.': 'Kỹ năng cần có hướng dẫn — tức là quy trình thực tế.',
  'That is too long for one skill; split it up.': 'Quá dài cho một kỹ năng; hãy tách ra.',
  'No skill called "{0}". Available: {1}': 'Không có kỹ năng nào tên "{0}". Hiện có: {1}',
  'Give a time as HH:MM, optionally with a weekday first — "17:00" or "fri 17:00".':
    'Nhập giờ dạng HH:MM, có thể thêm thứ ở đầu — "17:00" hoặc "fri 17:00".',
  '"{0}" is not a weekday. Use mon, tue, wed, thu, fri, sat or sun.':
    '"{0}" không phải thứ trong tuần. Dùng mon, tue, wed, thu, fri, sat hoặc sun.',
  'Could not find a time matching "{0}" in {1}.': 'Không tìm được thời điểm khớp "{0}" trong {1}.',
  '"{0}" is not a frequency. Pick one of: {1}.': '"{0}" không phải tần suất hợp lệ. Chọn một trong: {1}.',
  'A monthly task needs a time as HH:MM — "monthly 1 08:00".':
    'Việc chạy hằng tháng cần giờ dạng HH:MM — "monthly 1 08:00".',
  'A weekdays task needs a time as HH:MM — "weekdays 08:00".':
    'Việc chạy các ngày trong tuần cần giờ dạng HH:MM — "weekdays 08:00".',
  'Could not find a day {0} in the next year.': 'Không tìm được ngày {0} trong vòng một năm tới.',

  /* ── tài khoản & đăng nhập ─────────────────────────────────────── */
  'Wrong email or password.': 'Sai email hoặc mật khẩu.',
  'You cannot suspend or demote yourself.': 'Bạn không thể tự khoá hoặc tự hạ quyền của mình.',
  'No such account.': 'Không có tài khoản này.',
  'You cannot delete your own account.': 'Bạn không thể xoá tài khoản của chính mình.',
  'Set SESSION_SECRET — refusing to issue sessions without one.':
    'Hãy đặt SESSION_SECRET — máy chủ từ chối tạo phiên đăng nhập khi thiếu nó.',
  'Use a password of at least 10 characters.': 'Hãy dùng mật khẩu ít nhất 10 ký tự.',
  'That reset code or link is invalid, already used, or expired.':
    'Mã hoặc liên kết đặt lại mật khẩu không hợp lệ, đã được dùng, hoặc đã hết hạn.',
  'Your current password is not correct.': 'Mật khẩu hiện tại không đúng.',
  'That is the password you already have.': 'Đó chính là mật khẩu bạn đang dùng.',
  'That does not look like an email address.': 'Đó không giống một địa chỉ email.',
  'Registration is closed on this deployment.': 'Bản triển khai này đã đóng đăng ký.',
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
  'Unknown provider "{0}"': 'Không rõ nhà cung cấp "{0}"',
  'That is an empty key.': 'Key đang để trống.',
  'That key is already on this provider.': 'Key này đã có trong nhà cung cấp này.',
  'Eight keys per provider is the limit.': 'Mỗi nhà cung cấp tối đa tám key.',
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
  'That archive uses ZIP64, which this reader does not handle.': 'Tệp nén đó dùng ZIP64, trình đọc này chưa hỗ trợ.',
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
  'DATABASE_URL is not set. On Vercel the filesystem is ephemeral, so a hosted database is required — add Neon from Vercel → Storage and it sets DATABASE_URL for you.':
    'Chưa đặt DATABASE_URL. Trên Vercel hệ thống tệp là tạm thời, nên cần cơ sở dữ liệu được host — thêm Neon từ Vercel → Storage và nó sẽ tự đặt DATABASE_URL.',
  'The database is not ready yet — initStore() must resolve first.': 'Cơ sở dữ liệu chưa sẵn sàng — initStore() phải hoàn tất trước.',
  'That server id belongs to another account.': 'Id máy chủ đó thuộc về tài khoản khác.',
  'Process {0} is already using the database at {1}. Two processes writing to one PGlite database corrupt it beyond repair, so this one is stopping before it starts. Stop the other one, or set DATA_DIR to somewhere else.':
    'Tiến trình {0} đang dùng cơ sở dữ liệu tại {1}. Hai tiến trình cùng ghi vào một cơ sở dữ liệu PGlite sẽ làm hỏng không sửa được, nên tiến trình này dừng trước khi chạy. Hãy dừng tiến trình kia, hoặc đặt DATA_DIR sang chỗ khác.',
  'Another copy of Synapse is already running on port {0} and using {1}. Two processes writing to one database will damage it, so this one is stopping. Close the other one — or set PORT and DATA_DIR to run a second instance properly.':
    'Một bản Synapse khác đang chạy ở cổng {0} và dùng {1}. Hai tiến trình cùng ghi vào một cơ sở dữ liệu sẽ làm hỏng nó, nên bản này dừng lại. Hãy đóng bản kia — hoặc đặt PORT và DATA_DIR để chạy bản thứ hai đúng cách.',
  'The local database is not installed. Run `npm install` in this folder — @electric-sql/pglite is what Synapse stores everything in when there is no DATABASE_URL. If you installed with --omit=dev or --production, install again without it.':
    'Chưa cài cơ sở dữ liệu cục bộ. Chạy `npm install` trong thư mục này — Synapse lưu mọi thứ vào @electric-sql/pglite khi không có DATABASE_URL. Nếu bạn đã cài với --omit=dev hoặc --production, hãy cài lại không kèm tuỳ chọn đó.',

  /* ── công cụ của trợ lý ────────────────────────────────────────── */
  'Give at least one task.': 'Hãy đưa ít nhất một việc.',
  'That is {0} tasks; {1} at once is the limit. Do the most important ones first.':
    'Đó là {0} việc; tối đa {1} việc một lần. Hãy làm những việc quan trọng nhất trước.',
  '"{0}" is not a number this can read.': '"{0}" không phải con số đọc được.',
  '"{0}" has no meaning in a calculation. Use numbers, + - * / ^ ( ), lists and the named functions.':
    '"{0}" không có nghĩa trong phép tính. Dùng số, + - * / ^ ( ), danh sách và các hàm có tên.',
  'Expected {0} in "{1}" — the expression is incomplete or mis-bracketed.':
    'Cần {0} trong "{1}" — biểu thức chưa đầy đủ hoặc sai ngoặc.',
  '"{0}" ends before it is finished.': '"{0}" kết thúc khi chưa hoàn chỉnh.',
  'A list on its own is not a number. Use it inside a function, like sum([1, 2, 3]).':
    'Một danh sách đứng riêng không phải con số. Hãy dùng trong một hàm, ví dụ sum([1, 2, 3]).',
  '"{0}" is not a function this knows. Available: {1}.': '"{0}" không phải hàm được biết. Hiện có: {1}.',
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
  '{0} has no v{1}. It has {2} versions.': '{0} không có bản v{1}. Nó có {2} phiên bản.',
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
  'A workflow needs at least one step.': 'Chuỗi việc cần ít nhất một bước.',
  'A workflow is capped at 20 steps. Split it, or make a step do more.': 'Chuỗi việc tối đa 20 bước. Hãy tách ra, hoặc gộp nhiều việc vào một bước.',
  'Step {0} has no instruction.': 'Bước {0} chưa có hướng dẫn.',
  'A tool in this step needs approval and nobody is watching. Approve it in the conversation, or set the approval policy to allow it, then run the workflow again.':
    'Một công cụ ở bước này cần được duyệt mà không có ai theo dõi. Hãy duyệt trong cuộc trò chuyện, hoặc đổi chế độ duyệt để cho phép, rồi chạy lại chuỗi việc.',
  'The step ran out of agent steps before finishing. Split it into smaller steps.':
    'Bước này dùng hết số bước của trợ lý trước khi xong. Hãy tách thành các bước nhỏ hơn.',
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
  'stdio MCP servers cannot run on this deployment: they spawn a local command, which shared serverless infrastructure must not do. Use an http server instead.':
    'Máy chủ MCP stdio không chạy được trên bản triển khai này: chúng khởi chạy lệnh cục bộ, điều hạ tầng serverless dùng chung không được phép làm. Hãy dùng máy chủ http.',
  "stdio MCP servers are off by default because they run a command with access to the server's secrets. Set ALLOW_MCP_STDIO=1 to enable them on a machine you trust, or use an http server.":
    'Máy chủ MCP stdio mặc định bị tắt vì chúng chạy lệnh có quyền truy cập bí mật của máy chủ. Đặt ALLOW_MCP_STDIO=1 để bật trên máy bạn tin tưởng, hoặc dùng máy chủ http.',
  'The "{0}" MCP server is not reachable: {1}':
    'Không kết nối được máy chủ MCP "{0}": {1}',
  'There is no MCP server called "{0}" on this account.':
    'Tài khoản này không có máy chủ MCP nào tên "{0}".',
  '{0} is in the old Office format, which cannot be read. Save it as .docx, .xlsx or .pptx and add that.':
    '{0} ở định dạng Office cũ, không đọc được. Hãy lưu thành .docx, .xlsx hoặc .pptx rồi thêm tệp đó.',
  '{0} is not a kind of file that can be read. PDFs, Word, Excel, PowerPoint, text and code work.':
    '{0} không phải loại tệp đọc được. Đọc được PDF, Word, Excel, PowerPoint, văn bản và mã nguồn.',
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
};
