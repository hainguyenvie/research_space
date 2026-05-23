# OpenClaw on Replit — Research Space

Self-hosted OpenClaw assistant cho team research, chat qua web UI hoặc Telegram. Phiên bản này bổ sung **skill `daily-report`** tự động viết báo cáo tiến độ sprint + daily từ Linear vào một Google Doc duy nhất.

---

## Tổng quan tính năng

### 1. OpenClaw gateway (đã có sẵn từ trước)
- Express server (port `$PORT`, mặc định 3000) spawn child process `openclaw gateway` (port 18789).
- Web chat UI tại `/chat-ui/`, Telegram bot qua OpenClaw native channel, optional Zalo.
- Model: DeepSeek (`deepseek/deepseek-v4-flash` + fallback `deepseek-chat`).

### 2. ✨ Skill `daily-report` (mới)

Mỗi lần được gọi, skill này:

1. Query Linear active cycle hiện tại → lấy danh sách issues + project + assignee.
2. Query Linear activity trong khoảng cycle: issues hoàn thành / tạo mới / cập nhật, comments mới (làm log thủ công cho issue chưa xong).
3. Tìm (hoặc tạo) Google Doc tên `GOOGLE_DOCS_REPORT_DOC_NAME` trong folder `GOOGLE_DOCS_REPORT_FOLDER_ID`.
4. Render rich-formatted nội dung và **insert tăng dần** vào doc:
   - Mỗi sprint là một zone `🚀 Sprint #N` (HEADING_1) chứa plan + daily sections.
   - Newest sprint trên cùng. Khi sprint mới bắt đầu, sprint cũ + dailies của nó tự bị đẩy xuống dưới, **không bị overwrite**.
   - Trong cùng sprint hiện tại, mỗi lần re-run sẽ refresh-in-place: sprint plan luôn phản ánh trạng thái cycle hiện tại (issue mới thêm giữa sprint vẫn xuất hiện), daily sections luôn cập nhật.

#### Cách invoke skill

**a) Tự động — cron 6h sáng VN**
`artifacts/api-server/src/index.ts` đăng ký `node-cron` chạy `0 6 * * *` (Asia/Ho_Chi_Minh). 6h sáng là lúc data ngày hôm qua đã settle.

> ⚠️ Trên Replit autoscale, process có thể scale to zero khi idle → cron không fire. Cần một trong:
> - Replit Reserved VM (process always-on)
> - External pinger (UptimeRobot / cron-job.org) hit `/api/healthz` thường xuyên
> - Replit "Scheduled Deployment" riêng

**b) Manual — HTTP endpoint**
```bash
curl -X POST http://127.0.0.1:$PORT/api/reports/daily
```
Trả về JSON gồm `docUrl`, `cycleNumber`, `cycleIssueCount`, `daysRendered`, `commentsRendered`, `mode` (`new-doc` / `new-sprint` / `refresh-current-sprint`).

**c) Qua OpenClaw chat**
Skill `daily-report` được mount vào gateway via `skills.load.extraDirs`. Khi user chat "viết báo cáo hôm nay", "daily", "/daily" v.v., model gọi nội bộ skill (tức là curl endpoint `/api/reports/daily`).

---

## Cấu trúc code

| Path | Vai trò |
|---|---|
| `artifacts/api-server/src/lib/daily-report.ts` | Logic chính: Linear query, doc parse, incremental insert. Export `generateDailyReport()`. Cũng tự chạy như CLI khi invoke trực tiếp. |
| `artifacts/api-server/src/routes/reports.ts` | `POST /api/reports/daily` |
| `artifacts/api-server/src/index.ts` | Đăng ký cron tại startup |
| `artifacts/api-server/src/lib/openclaw-gateway.ts` | Thêm `skills.load.extraDirs` trỏ tới `plugin-skills/` |
| `artifacts/api-server/plugin-skills/daily-report/SKILL.md` | Prompt cho model invoke skill |
| `scripts/src/google-oauth-init.ts` | Helper 1-lần: lấy `GOOGLE_REFRESH_TOKEN` qua OAuth flow (mở browser, capture callback `localhost:53682`) |

---

## Triển khai trên Replit

### 1. Secret cần điền
Mở Replit Secrets, thêm các key sau (theo `.env.example`):

```
DEEPSEEK_API_KEY=             # bắt buộc — cho chat
TELEGRAM_BOT_TOKEN=           # tùy chọn — Telegram channel
ZALO_BOT_TOKEN=               # tùy chọn — Zalo channel
LINEAR_API_KEY=               # bắt buộc cho skill daily-report
GOOGLE_CLIENT_ID=             # bắt buộc cho skill daily-report
GOOGLE_CLIENT_SECRET=         # bắt buộc cho skill daily-report
GOOGLE_REFRESH_TOKEN=         # bắt buộc cho skill daily-report
GOOGLE_DOCS_REPORT_FOLDER_ID= # bắt buộc cho skill daily-report
GOOGLE_DOCS_REPORT_DOC_NAME=  # optional, default: "Báo cáo công việc — Resuck Excellent"
OPENCLAW_GATEWAY_TOKEN=       # optional — random UUID auto-sinh nếu trống
PORT=3000
```

### 2. Lấy `GOOGLE_REFRESH_TOKEN`

OAuth flow cần browser + localhost callback → chạy **trên máy local** (không phải Replit):

```bash
pnpm --filter @workspace/scripts run oauth:google
```

Script sẽ mở browser → bạn approve → terminal in `GOOGLE_REFRESH_TOKEN=...`. Copy giá trị paste vào Replit Secret.

**Setup GCP một lần** (nếu chưa có): tạo project → enable Docs API + Drive API → tạo OAuth Client (Desktop type) → trong Audience → add email của bạn vào Test users. Scope cần là `documents` + `drive` (full).

### 3. Lấy `GOOGLE_DOCS_REPORT_FOLDER_ID`

URL folder Drive dạng `https://drive.google.com/drive/folders/<ID>`. Đảm bảo folder được sở hữu bởi account đã authorize OAuth.

### 4. Run

Replit sẽ tự `pnpm install` + `pnpm run build` qua `.replit`. Workflow `Project` chạy `pnpm --filter @workspace/api-server run dev`.

Verify:
- `GET /api/healthz` → `{"status":"ok"}`
- `GET /api/openclaw/health` → gateway ready
- `POST /api/reports/daily` → JSON response với `docUrl`
- Mở Google Doc theo `docUrl` → check format

---

## Việc còn phải làm trên Replit

### Bắt buộc
- [ ] Đẩy hết secrets vào Replit Secrets (đặc biệt `GOOGLE_REFRESH_TOKEN` lấy từ máy local)
- [ ] Quyết định chiến lược keep-alive cho cron (Reserved VM / external pinger / scheduled deployment)
- [ ] Test `/api/reports/daily` chạy thông trên Replit
- [ ] Test gateway load được skill `daily-report` (xem log gateway có publish entry không)
- [ ] Test invoke skill qua chat — gõ "viết báo cáo hôm nay" trên web chat hoặc Telegram, verify model gọi đúng endpoint

### Nên làm sớm
- [ ] Pagination cap (200) — log warning khi gần cap
- [ ] Retry logic cho Linear / Google API khi network blip
- [ ] Markdown rendering của comment body (Linear support `**bold**`, `[link](url)`, lists)
- [ ] Filter scope (`/daily mine` chỉ lấy issues assign cho mình)
- [ ] Telegram command `/daily` mapping rõ ràng (nếu OpenClaw native skill routing chưa đủ)

### Optional
- [ ] Web chat UI thêm 1 button "Tạo báo cáo" để gọi endpoint trực tiếp
- [ ] Notify Telegram khi cron chạy xong (gửi link doc tự động)
- [ ] Lưu sprint history vào Postgres để dashboard / metrics tuần/tháng (DB layer đã có sẵn nhưng schema rỗng)
- [ ] Tách env loader của `daily-report.ts` thành package dùng chung
- [ ] `.env.example` đã có lại — đảm bảo CI / fresh deploy đọc được

---

## Lệnh thường dùng

```bash
# Install deps (Replit auto)
pnpm install

# Typecheck cả project
pnpm run typecheck

# Build
pnpm run build

# Dev (Replit Workflow "Project")
pnpm --filter @workspace/api-server run dev

# OAuth init (chạy local 1 lần để lấy refresh token)
pnpm --filter @workspace/scripts run oauth:google

# Manual trigger daily report (sau khi server đang chạy)
curl -X POST http://127.0.0.1:$PORT/api/reports/daily

# Chạy daily-report CLI mode trực tiếp (debug)
pnpm dlx tsx ./artifacts/api-server/src/lib/daily-report.ts
```

---

## Architecture decisions

- **Single Google Doc strategy**: cả workspace dùng 1 doc duy nhất chứa toàn bộ lịch sử sprints + dailies, newest-on-top. Sprint cũ được preserve bằng cách incremental refresh chỉ thay đổi zone của sprint hiện tại.
- **Linear Cycle = source of truth cho sprint**: query `cycles(filter:{isActive:eq:true})` thay vì tự suy ra sprint window từ ngày. Mid-sprint cycle membership changes tự reflect.
- **Comments as activity log**: comments mới trong ngày được render vào daily section như "logs". Dùng để user log progress khi issue chưa close.
- **Cron in-process**: dùng `node-cron` ngay trong api-server thay vì external scheduler — đơn giản, chỉ cần process alive. Trade-off: trên Replit autoscale có thể miss tick → cần keep-alive (xem note ở trên).
- **OAuth user credentials over service account**: doc thuộc về user account thật, dễ chia sẻ và preview. Service account ít maintenance hơn nhưng phải tạo doc trong Shared Drive.

---

## Notes

- File `.env.example` chỉ có placeholder. `.env` thật ở local đã gitignored, không vào repo.
- Secret rò có khả năng xảy ra qua console log — luôn check log Replit không in plaintext secret.
- Linear "url" field trên `Cycle` không tồn tại trong API hiện tại, nên không có link sprint clickable (chỉ có link project + link issue).
- DB layer (`lib/db/`, Postgres + Drizzle) hiện chưa dùng. Schema rỗng. Khi cần persist history thì bật.
