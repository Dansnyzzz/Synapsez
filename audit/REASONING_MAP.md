# REASONING_MAP — mọi điểm gọi model (AUDIT_RULES v5 PHẦN XIV, vòng v4/v5 — cập nhật 2026-11-03)

Mỗi lời gọi đều đi qua một cửa: `streamCompletion` (`server/providers/index.js`) → adapter (`anthropic.js` · `openaiCompatible.js` · `google.js`). Tham số suy luận do adapter đặt theo provider; bảng ánh xạ ở cuối.

| Điểm gọi (file:line) | Loại tác vụ | Model | Effort | Tools | max_tokens | Streaming | Cache | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| `server/agent.js:1895` | Lượt chat / agent | model của tài khoản (hoặc Auto) | `prefs.effort` (mặc định `high`, `settings.js:12`) | danh mục hoãn tải (`buildTools`) | `outputBudget` (cửa sổ − prompt, theo model) | có | Anthropic: breakpoint cuối system + tools (`anthropic.js:136-137`); OpenRouter `markPromptCache`; OrcaRouter: không có marker | lượt chính |
| `server/agent.js:2090` | Cổng chất lượng — vòng sửa (QC-001) | cùng model | `low` | 0 | như trên | có | không | chỉ chạy khi có liên kết không nguồn; ≤ `QUALITY_GATE_ROUNDS` |
| `server/compact.js:384` | Gấp hội thoại (compaction) | model nhỏ cùng provider khi rẻ hơn (`roleModel.js`) | tối đa `medium` (`compact.js:393`) | 0 | theo role | có | không | nhận biết dữ liệu Google |
| `server/subagents.js:147` | Sub-agent (`run_parallel`) | model của tài khoản | `subagentEffort`: `low`, hoặc `medium` khi tài khoản ở `xhigh`/`max` (`subagents.js:78`) | chỉ tool đọc | theo role | có | không | không gọi lồng sub-agent |
| `server/vision.js:251` | Đọc ảnh cho model không nhìn được | model có thị giác | `low` | 0 | ngắn | có | không | có hạn giờ từng engine + tổng |
| `server/tools/extract.js:105` | `web_extract` | model nhỏ (role) | `low` | 0 | theo role | có | không | |
| `server/research/plan.js:57` + `research/llm.js:55` | `deep_research` (lập kế hoạch, tranh luận, trọng tài) | model của hội thoại | `low` cho kế hoạch; theo vai cho phần còn lại | 0 | theo role | có | không | trích dẫn bắt buộc, độ tin cậy chấm bằng code |

## Ánh xạ effort theo provider (đã kiểm ở GAP-014 / PERF-025)

| Provider | Tham số gửi đi | `max` | Khi bị từ chối | Bằng chứng |
|---|---|---|---|---|
| Anthropic | `output_config.effort` + thinking `adaptive` (`display: summarized`) | gửi `max` | hạ `max→xhigh→high→bỏ`; mức đã nhận được **nhớ theo model** (PERF-025) | `server/providers/anthropic.js:163-205` |
| OpenRouter | `reasoning: { effort }` cho mọi model (trừ model thư viện biết không suy luận) | gửi `xhigh` | như trên; nhớ theo địa chỉ + model | `openaiCompatible.js:150-157` |
| OpenAI trực tiếp, OrcaRouter | `reasoning_effort` chỉ cho model suy luận — nay đọc **tên sau dấu `/` cuối** nên `openai/gpt-5…` của OrcaRouter nhận được (GAP-014) | gửi `max` | hạ bậc + nhớ (PERF-025) | `openaiCompatible.js:150-160` |
| Google Gemini | `thinkingLevel` (low/medium/high); `xhigh`,`max` → HIGH (trần của API); dạng budget cũ tăng dần 1.024 / 8.192 / 16.384 / 24.576 / 24.576 (GAP-014, `80c9eb2` — high từng là −1 "model tự quyết", có thể nghĩ ít hơn medium) | = HIGH | MEDIUM bị từ chối → HIGH (làm tròn lên, giữ chất lượng); budget bị từ chối → −1 → bỏ | `server/providers/google.js:20-55` |

**Tương đương (M15):** "tương đương" = đạt cùng ngưỡng trên cùng bộ eval, không phải cùng tham số. Bộ eval scripted (`test/eval/`, 15 ca) không đo chất lượng theo mức effort.

**Ma trận live đầu tiên (M14, RSN-001, 2026-11-03, chủ cho phép ~30 request):** `EVAL_MODEL=openrouter/nvidia/nemotron-3.5-super-vl:free` (free, có tools + reasoning), `EVAL_EFFORT` = low / medium / high, 7 ca có lựa chọn tool để đo → 21 request, chạy với DB trong bộ nhớ (không chạm dữ liệu deployment).

| Ca | low | medium | high |
|---|---|---|---|
| tool-choice/own-documents | ✓ | ✓ | ✓ |
| tool-choice/current-events | ✓ | ✓ | ✓ |
| tool-choice/read-before-write | ✗ grep | ✗ glob | ✗ glob |
| tool-choice/one-page-extract | ✗ web_fetch | ✗ web_fetch | ✗ web_fetch |
| tool-choice/picture-on-the-computer | ✗ list_dir | ✗ glob | ✗ glob |
| tool-choice/figure-on-the-cloud-computer | ✗ list_dir | ✗ list_dir | ✗ list_dir |
| budget/simple-question | ✗ không gọi tool | ✗ | ✗ |

Đọc: với model này, **lựa chọn tool như nhau ở cả ba mức** (2/7) → `low` là điểm rẻ nhất không mất gì cho bước chọn tool; chọn model quan trọng hơn chọn mức. Giới hạn của phép đo (evaluator, 2026-11-03): không ghi token theo từng mức, nên chưa tách được "effort không đổi gì" với "effort không được áp dụng"; mỗi ô một lượt, chỉ chấm lời gọi đầu; Gemini và OrcaRouter chưa đo. Lần sau: `--json` giữ model, mức effort, lý do và chi phí từng ca — input, output và phần reasoning trong output (RSN-003) — để thấy mức effort có thật sự được áp dụng không. Ba ca "thăm dò trước" (grep/glob/list_dir trước khi đọc) là cách làm chấp nhận được, eval chấm khắt khe lời gọi đầu; hai ca là sai thật (web_fetch thay vì extract; tính nhẩm thay vì calculate). Phạm vi: một model, một lượt mỗi ô — chưa phải ma trận nhiều model; chạy thêm model = thêm request trên hạn mức free dùng chung. Haiku 4.5 (RSN-002) không còn áp dụng: chủ đã bỏ provider Anthropic.

**Kiểm tham số hợp lệ:** Anthropic không dùng `thinking.type: "enabled"` + `budget_tokens` (M1) — [FACT] `anthropic.js:170-172` chỉ dùng `adaptive`; không đặt `temperature/top_p` ở lời gọi có thinking (M7) — [FACT] grep `temperature` trong `server/providers/` không có ở các adapter chat. Cắt cụt (`max_tokens`) được nhận diện là lỗi, không phải thành công (M9) — [FACT] `server/providers/stop.js` (`truncated`) + ghi chú trên transcript.