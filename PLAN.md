# Jira Logwork & Daily Report — Kế hoạch xây dựng

## 1. Mục tiêu

Một web app chạy local thay thế Chrome extension `jira-daily-tool` cũ, cho phép:

- Tạo task trên Jira (title / description / DoD do AI sinh hoặc tự điền), gắn sprint, epic, parent task
- Log work cho task theo ngày tuỳ chọn, có kiểm tra quy tắc giờ
- Sinh daily report dạng text để copy vào chat
- Thống kê giờ đã log theo ngày / tuần / sprint

## 2. Quyết định kiến trúc

### 2.1 Nguồn dữ liệu — điểm quan trọng nhất

**Jira là nguồn sự thật duy nhất** cho issue và worklog. App không đồng bộ hai chiều, không copy task từ Jira xuống DB.

SQLite chỉ lưu những thứ Jira không có chỗ chứa:

| Bảng | Nội dung | Vì sao không để trên Jira |
|---|---|---|
| `settings` | Jira URL, email, API token, đường dẫn `claude`, board mặc định, giờ làm việc | Cấu hình local |
| `task_drafts` | Task AI vừa sinh, chưa push lên Jira | Chưa tồn tại trên Jira |
| `report_templates` | Template text của daily report | Thuần local |
| `report_history` | Report đã sinh, để xem lại | Jira không lưu report |
| `jira_field_cache` | id của custom field (Story Points, Epic Link, Sprint) | Cache, tránh gọi `/field` mỗi lần |

Luồng vòng đời một task:

```
[AI Composer] → task_drafts (SQLite) → bấm "Create on Jira"
                                            ↓
                                    Issue thật trên Jira
                                    (draft bị xoá khỏi SQLite)
                                            ↓
                              [Task Board] đọc live từ Jira mỗi lần mở
                                            ↓
                              bấm "Log work" → POST worklog lên Jira
```

Task Board luôn gọi Jira để lấy danh sách, không đọc DB. Bấm refresh là ra dữ liệu mới nhất. Không bao giờ có chuyện DB lệch với Jira, vì DB không giữ bản sao.

### 2.2 Stack

- **Next.js 15** (App Router, TypeScript) — Route Handlers trong `app/api/*` đóng vai trò backend Node luôn, không cần Express riêng như tool cũ
- **Tailwind CSS + shadcn/ui** — component sẵn có, tự hỗ trợ dark mode
- **better-sqlite3 + Drizzle ORM** — file `data/app.db`, không cần server DB
- **Claude Code CLI** — binary `claude` có sẵn trên máy, sinh title/description/DoD
- Jira Cloud REST API v3 + Agile API v1.0, Basic auth (email + API token) như tool cũ

Token Jira chỉ nằm ở server side, không bao giờ gửi xuống browser. AI thì không
có token nào để giữ: CLI chạy bằng phiên đăng nhập của chính máy đó.

### 2.3 Quy tắc thời gian

Công ty **chỉ kiểm tra một ngày có đủ 8h hay chưa**, không kiểm tra worklog rơi đúng khung giờ làm việc. App vì vậy không mô hình hoá dòng thời gian trong ngày.

- Ngày thường: định mức **8h**. Cảnh báo khi chưa đủ, không cảnh báo khi vượt
- **Thứ 7 / Chủ nhật**: định mức 0, mọi giờ log đều hợp lệ, không cảnh báo thiếu
- **OT gộp chung vào tổng**, không tách cột riêng. Giờ vượt 8h ngày thường và giờ cuối tuần được tô màu khác để nhận diện, nhưng chỉ có một con số tổng
- Bước log mặc định **0.5h**, đổi được trong Settings (0.25 / 0.5 / 1h). Kèm preset bấm nhanh `0.5, 1, 2, 4, 8` — cũng sửa được
- `started` gửi lên Jira đặt mặc định 09:00 + offset tuần tự cho các worklog cùng ngày. Đây thuần tuý là giá trị hợp lệ Jira đòi hỏi, **không hiển thị trên UI** và không mang ý nghĩa gì với người dùng

### 2.4 Chọn sprint

PM không complete sprint cũ nên `openSprints()` trả về rất nhiều sprint cùng lúc — không dùng được để đoán sprint hiện tại.

App lấy toàn bộ sprint của board 13 qua `/rest/agile/1.0/board/13/sprint`, rồi chọn sprint có `startDate <= hôm nay <= endDate`. Nếu khớp nhiều thì lấy cái `startDate` gần nhất. Dropdown luôn cho đổi tay.

### 2.5 Tìm và tự nhận task

Board chính chỉ hiện task `assignee = currentUser()`. Màn **Tìm & nhận task** riêng có 3 chế độ:

1. **Sprint đang chạy** — lọc `assignee IS EMPTY` hoặc task của người khác
2. **Toàn project VT** — gồm backlog và sprint đã đóng
3. **JQL tự do** — kèm preset dựng sẵn, lưu được preset riêng vào SQLite

Nhận task = `PUT /rest/api/3/issue/{key}/assignee` với `accountId` của mình.

### 2.6 Cấu trúc task và story point

Ba tầng:

```
Epic  →  Task (thuộc epic)  →  Sub-task (dưới task)  ←── chỉ log giờ ở đây
```

**Epic không phải task cha** — nó là tầng trên nữa. Task chọn epic của mình; sub-task **thừa hưởng** epic từ task cha, không tự chọn. Màn tạo task vì vậy đổi trường theo issue type:

| Issue type | Task cha | Epic | Sprint |
|---|---|---|---|
| Sub-task | Combobox, **bắt buộc** | Chỉ hiển thị, theo cha | Chỉ hiển thị, theo cha |
| Task / Support / … | Không có | Combobox chọn được | Dropdown chọn được |

Sub-task **không gửi epic và sprint** lên Jira — cả hai thừa hưởng từ task cha, xem 3b.3.

Issue type trong VT: `Task` `Bug` `QC` `Improve` `Support`.

- **Dev tạo `Sub-task` là chính** (mặc định), thêm `Task` và `Support`
- **`Bug` `QC` `Improve` thường do QC tạo** — nằm sau nút "+ loại khác", chọn vào thì hiện cảnh báo. Không chặn, vì đôi khi vẫn cần thật

**Chỉ log giờ vào sub-task.** Task cha không nhận worklog, chỉ đóng vai trò gom nhóm.

Quy đổi point sang giờ:

| Point | Ước lượng |
|---|---|
| 1 | 1 – 2h |
| 2 | 4h |
| 3 | 1 – 2 ngày (8 – 16h) |

- **Không có point lớn hơn 3.** Việc lớn hơn phải tách thành nhiều task con
- Task cha **không tự cộng point** — người dùng phải tự nhập tổng. App tính sẵn `tổng point task con`, so với giá trị task cha đang ghi, và cho nút điền một chạm khi lệch
- Ước lượng **chỉ mang tính tượng trưng**. Log nhiều hay ít hơn đều bình thường. App hiện cảnh báo mềm khi vượt mốc trên nhưng **không bao giờ chặn** thao tác log
- Bảng quy đổi sửa được trong Settings

### 2.7 Status

Workflow VT dài và tuỳ biến: `TO DO` → `COMMITED CODE FEATURE BRANCH` → `IN PROGRESS` → `READY FOR TEST ON DEVELOP / INTEGRATION / STAGING` → `VERIFIED ON DEVELOP / INTEGRATION / STAGING` → `DONE`.

App **không hardcode danh sách này**. Mỗi issue đọc transition khả dụng qua `GET /rest/api/3/issue/{key}/transitions`, đổi status bằng `POST` cùng endpoint. Workflow đổi thì app tự đổi theo.

Màu pill suy ra từ tiền tố tên status (`VERIFIED …`, `READY FOR TEST …`) và `statusCategory` do Jira trả về, không phải từ danh sách cứng.

### 2.8 Quy ước tiền tố title

Dạng thật: `[spt 63][Support] Review các pull request, review technical detail…`

- `[spt {n}]` — **tự suy ra** từ tên sprint đang chọn (`VT Sprint 63` → `[spt 63]`). Mẫu sửa được trong Settings, để trống thì bỏ hẳn
- `[Support]` `[Mobile]` `[BE]` `[Web]` `[Desktop]` — chọn bằng chip
- **Chọn được nhiều tiền tố, thứ tự ghép theo thứ tự bấm.** Chip đang chọn hiện số thứ tự. Bỏ chọn hết thì title không có tiền tố
- **Thêm / sửa / xoá / đổi thứ tự** tiền tố trong Settings; màn tạo task có nút thêm nhanh, thêm ở đâu cũng vào chung một danh sách lưu trong SQLite
- Ô Title **chỉ chứa phần nội dung**, không gõ tiền tố vào. Có dòng preview hiện title hoàn chỉnh. Tách vậy để app khỏi phải đoán đâu là tiền tố khi người dùng sửa tay
- Prompt được dặn sinh title **không kèm tiền tố**; app tự ghép vào để tránh AI bịa sai quy ước
- DoD là **textarea gạch đầu dòng** sửa tự do, không phải checklist checkbox

## 3. Màn hình

### 3.1 Task Board (trang chủ)

**Board chứa subtask đang assign cho người dùng** — `assignee = currentUser() AND type = Subtask`. Không có gì thông minh hơn thế: mọi việc thu hẹp do bộ lọc lo (sprint, trạng thái, tiền tố, ô tìm). Muốn nhặt task của người khác thì sang màn *Tìm & nhận task*.

Layout hai cột: cột chính là thanh dung lượng ngày + danh sách task, cột phải là bảng tuần và tiến độ sprint.

```
┌──────────────────────────────────────────────┬──────────────────┐
│  Sprint 24 · 14/07 – 27/07 · đang chạy       │  Tuần 15–21/07   │
│  Task board            [‹] T6 19/07 [›]      │  T2 ▓▓▓▓▓▓  8.0  │
│ ┌──────────────────────────────────────────┐ │  T3 ▓▓▓▓▓▓ 10.0  │
│ │ 6.5 / 8h   ⚠ thiếu 1.5h                  │ │  T4 ▓▓▓▓░░  6.0  │
│ │ ▐22485 2h▌▐22486 1.5h▌▐22490 3h▌┈còn1.5┈ │ │  T5 ▓▓▓▓▓▓  8.0  │
│ └──────────────────────────────────────────┘ │  T6 ▓▓▓▓▓░  6.5  │
│  [Sprint▾][Epic▾][Status▾][tìm] [+ Task mới] │  T7 ▓▓▓░░░  4.0  │
│ ┌──────────────────────────────────────────┐ │  CN ░░░░░░   —   │
│ │ PROJ-485  In progress   đã log 2h        │ │  Tổng     42.5h  │
│ │ [Mobile] Reset trusted device            │ ├──────────────────┤
│ │ Epic Security · Parent PROJ-470 · SP 3   │ │  Sprint 24       │
│ │        [−] 1.5h ▾ [+] [ghi chú] [ Log ]  │ │  Đang làm     4  │
│ └──────────────────────────────────────────┘ │  SP      11 / 21 │
│ ┌──────────────────────────────────────────┐ │  Đã log    63.5h │
│ │ PROJ-486  ...                            │ │  Còn      6 ngày │
└──────────────────────────────────────────────┴──────────────────┘
```

- **Thanh dung lượng**, không phải timeline. Chia 8h theo tỉ lệ từng task, phần dư hiện dạng nét đứt. Không có mốc giờ, không có nghỉ trưa — thứ tự log không mang ý nghĩa
- Cuối tuần: thanh chuyển màu OT, bỏ mẫu số `/ 8h`, không cảnh báo thiếu giờ
- **Nhóm theo task cha.** Mỗi task cha là một khối, task con nằm trong. Task cha không có nút Log, chỉ hiện `tổng point task con` và nút điền khi lệch với giá trị đang ghi
- Mỗi task con có badge `SP 2 · 4h / 4h` kèm thanh mini, đỏ khi vượt mốc trên
- Dropdown status ngay trên dòng, danh sách lấy từ transition thật của issue
- Filter theo sprint / prefix / status, ô lọc nhanh
- Mỗi dòng một nút **Log** riêng. Nút `1.5h ▾` mở menu preset chọn nhanh, `+`/`−` nhảy theo bước cấu hình được

### 3.2 Task Composer (tạo task mới)

```
┌─────────────────────────────────────────────────────────────┐
│  Task mới                                                   │
├─────────────────────────────────────────────────────────────┤
│  Mô tả ngắn việc bạn định làm                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ làm màn hình quên mật khẩu cho app mobile, có otp sms  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                     [✨ Generate với AI]     │
├─────────────────────────────────────────────────────────────┤
│  Title        [ [Mobile] Màn hình quên mật khẩu qua OTP ]   │
│  Description  [ ...markdown, sửa được... ]                  │
│  DoD          [ ☐ Gửi OTP thành công                    ]   │
│               [ ☐ Validate OTP hết hạn sau 5 phút       ]   │
├─────────────────────────────────────────────────────────────┤
│  Project [VT ▾]  Type [Sub-task ▾]  SP [3]                  │
│  Sprint  [Sprint 24 ▾]  Epic [Security ▾]  Parent [VT-224▾] │
├─────────────────────────────────────────────────────────────┤
│           [Lưu draft]        [Create on Jira]               │
└─────────────────────────────────────────────────────────────┘
```

- Mọi field AI sinh ra đều sửa được, hoặc bỏ qua AI điền tay hoàn toàn
- **Task cha và Epic là combobox tìm kiếm**, gõ lọc theo key / tên / epic. Combobox task cha có nút đổi phạm vi *Sprint đang chạy* ↔ *Toàn project VT*, mặc định chỉ sprint cho gọn
- Chọn task cha xong, epic tự hiện theo cha (xem 2.6)
- "Lưu draft" cất vào SQLite, quay lại sửa tiếp sau
- "Create on Jira" mới thực sự tạo issue → hiện toast kèm link issue, hỏi "Log work luôn cho task này?"
- Description và DoD convert sang ADF (Atlassian Document Format) trước khi gửi, DoD thành bullet list nối vào cuối description

### 3.3 Daily Report

Giữ format tool cũ, dữ liệu lấy từ worklog thật trên Jira của ngày đã chọn:

```
Daily Report 20-07-2026

Previous day:
- PROJ-485 | [Mobile] Xử lý reset/re-register trusted device
- PROJ-486 | [Mobile] Tích hợp refresh trusted device vào app lifecycle
Today:
-
```

Kèm nút Copy, chọn ngày, bảng 7 ngày trong tuần (có cả T7/CN), thống kê sprint, và xuất CSV worklog. Chỉ ngày thường thiếu giờ mới bị cảnh báo.

### 3.4 Tìm & nhận task

Ba tab, chi tiết ở mục 2.5. Mỗi kết quả hiện assignee hiện tại (`Chưa ai nhận` / tên người khác) và nút **Nhận task**. Tab JQL có ô textarea gõ tự do, preset bấm sẵn, và lưu preset riêng.

### 3.5 Settings

Jira URL / email / token + nút **Test connection**, đường dẫn `claude` và model, board mặc định, định mức ngày, bước nhảy +/−, danh sách preset chọn nhanh, cách xử lý cuối tuần, và template report.

## 3a. Kết quả thăm dò thực tế — 19/07/2026

Chạy toàn `GET` trên `your-company.atlassian.net`. **Phần này là sự thật đã kiểm chứng, thắng mọi suy đoán ở mục 3b.**

### Danh tính và project

```
accountId  <accountId của bạn>
timeZone   Asia/Saigon
project    VT · Tên project · id 10012
style      next-gen   ← TEAM-MANAGED
simplified true
cloudId    <cloudId của instance>
```

**VT là team-managed.** Toàn bộ phần tranh cãi Epic Link ở 3b.2 trở nên vô nghĩa — team-managed luôn dùng `parent`.

### Issue type

| id | name | subtask | hierarchyLevel |
|---|---|---|---|
| 10050 | Epic | false | **1** |
| 10047 | Story | false | 0 |
| 10048 | Task | false | 0 |
| 10049 | Bug | false | 0 |
| 10052 | QC | false | 0 |
| 10054 | Improve | false | 0 |
| 10057 | Support | false | 0 |
| 10051 | **Subtask** | **true** | **-1** |

Tên là `Subtask` **viết liền**, không phải `Sub-task`. Có thêm `Story` mà trước đó chưa nhắc tới.

### Field id đã xác nhận

| Field | id | schema.custom |
|---|---|---|
| Sprint | `customfield_10020` | `com.pyxis.greenhopper.jira:gh-sprint` |
| Story point estimate | `customfield_10016` | `com.pyxis.greenhopper.jira:jsw-story-points` |

**Sửa lại 3b.4:** story point field ở đây là `jsw-story-points`, **không** phải `...customfieldtypes:float`. Nghĩa là `schema.custom` **phân biệt được**, không cần khớp theo `name` như nghiên cứu nói. Vẫn nên khớp cả hai cách để chắc.

Createmeta cho `Subtask` (10051): `parent` **required**. Cho `Task` (10048): `parent` optional.

### `parent` đa nghĩa — ĐÃ XÁC NHẬN

```
PROJ-877  Subtask  →  parent = PROJ-867  (Task)
PROJ-867  Task     →  parent = PROJ-615  (Epic)
```

Giả thuyết `[SUY]` ở 3b.2 giờ là sự thật đo được trên chính instance này.

### Sprint trên Subtask — đọc được, KHÔNG ghi được

Ban đầu tôi kết luận sai chỗ này, ghi lại cho rõ.

**Quan sát:** `customfield_10020` vừa nằm trong createmeta của Subtask, vừa có giá trị thật — cả ba subtask đều mang `VT Sprint 64 (active)` giống task cha.

**Kết luận sai:** "subtask gán sprint được, tài liệu sai."

**Sự thật, phát hiện khi tạo issue thật:**

```
customfield_10020: Issue '{0}' is a subtask and subtasks cannot be
associated to a sprint. It's associated to the same sprint as its parent.
```

Subtask **thừa hưởng** sprint từ task cha để hiển thị, nhưng **không nhận** giá trị sprint khi tạo. Đọc và ghi là hai chuyện khác nhau — createmeta liệt kê field không có nghĩa là ghi được.

**Quy tắc:** không bao giờ gửi field sprint cho subtask. Chặn ở tầng `createIssue` chứ không phải ở UI, để không caller nào tái phạm.

### 9 sprint cùng `active` — đúng như mô tả

| id | name | start | end |
|---|---|---|---|
| 1911 | VT Sprint 58 | 2026-03-13 | 2026-03-27 |
| … | … | … | … |
| 2055 | VT Sprint 65 | 2026-06-30 | 2026-07-14 |
| **2057** | **VT Sprint 66** | **2026-07-15** | **2026-07-29** |

Lọc `endDate >= hôm nay` còn **đúng một** sprint: **VT Sprint 66**. Thuật toán ở 3b.5 hoạt động chính xác trên dữ liệu thật.

### Worklog

```
started   2026-06-17T14:40:00.000+0700     ← offset không dấu hai chấm, đúng như 3b.8
timeSpent 6h = 21600s
```

**Task cha PROJ-867 có 0 worklog**, ba subtask thì có. Quy ước "chỉ log vào task con" xác nhận bằng dữ liệu thật.

### Story point rollup — xác nhận

PROJ-867 (Task) ghi **9.0**. Ba subtask con mỗi cái **3.0** → tổng 9.0. Đúng quy ước "task cha tự cộng tổng point task con".

### Transition — 10 cái, id lệch hoàn toàn với status

| transitionId | tên transition | → statusId | tên status |
|---|---|---|---|
| 2 | Ready For Test On Develop | 10047 | Ready For Test On Develop |
| 11 | To Do | 10044 | To Do |
| 21 | In Progress | 10045 | In Progress |
| 31 | Done | 10046 | Done |
| 6 | COMMITED CODE FEATURE BRANCH | 10051 | COMMITED CODE FEATURE BRANCH |

Chú ý **hoa thường không nhất quán** trong Jira của bạn: `Ready For Test On Develop` nhưng `READY FOR TEST ON INTEGRATION`, `VERIFIED ON DEVELOP`. App phải so sánh không phân biệt hoa thường, và hiển thị đúng nguyên văn Jira trả về.

`statusCategory`: `new` cho To Do, `done` cho Done, `indeterminate` cho tất cả phần còn lại — nên **không dùng statusCategory để tô màu**, phải suy từ tên.

### JQL không lọc được subtask theo sprint — phát hiện ở Phase 2

| JQL | Kết quả |
|---|---|
| `project = VT AND sprint = 2053` | 3 |
| `… AND sprint = 2053 AND issuetype in subTaskIssueTypes()` | **0** |
| `… AND issuetype in subTaskIssueTypes()` (bỏ sprint) | 3 |

Subtask **có** giá trị `customfield_10020` khi đọc trực tiếp, nhưng JQL không so khớp được. Thử `"Sprint" = 2053`, `sprint in (2053)`, `cf[10020] = 2053` — đều trả 0.

**Cách làm đúng, hai bước:**

1. Lấy key task cha trong sprint: `sprint = {id} AND issuetype not in subTaskIssueTypes()`
2. Lấy subtask theo `parent in (…)`, chia lô 50 key một lần

Không lọc assignee ở bước 1 — task cha có thể của người khác trong khi subtask là của mình.

Đây chính là lý do tool cũ `jira-daily-tool` query task cha trước rồi mới lấy subtask. Cấu trúc đó không thừa, nó là cách vòng qua đúng giới hạn này.

### Quy ước tiền tố title — dữ liệu thật từ 60 issue gần nhất

| Tiền tố | Lần |
|---|---|
| `[Mobile]` | 39 |
| `[AppB]` | 32 |
| `[SDK]` | 13 |
| `[Support]` | 12 |
| `[Bug]` | 5 |
| `[iOS]` | 3 |
| `[DocumentFR]` | 3 |
| `[Improve]` | 2 |

Tổ hợp hay dùng: `[Mobile][AppB]` (25), `[Mobile][SDK]` (13), `[spt NN][Support]` (12), `[Bug][AppB]`, `[Bug][iOS][AppB]`, `[Improve][Mobile][AppB]`.

Ba nhận xét quan trọng:

1. **`[BE]` `[Web]` `[Desktop]` không xuất hiện lần nào** trong 60 issue của bạn — có thể là của người khác trong team
2. **`[spt NN]` chỉ đi kèm `[Support]`**, tỉ lệ 12/12. Không phải tiền tố dùng chung
3. Cấu trúc thực tế là *loại* → *nền tảng* → *sản phẩm*: `[Improve][iOS][AppB]`

**Quyết định:** giữ danh sách mặc định `[Support]` `[Mobile]` `[BE]` `[Web]` `[Desktop]`, người dùng tự thêm bớt. **Không tự học từ lịch sử** — mỗi người làm ở cụm tiền tố khác nhau, học từ lịch sử người này áp cho người kia là sai. Thống kê trên chỉ để tham khảo.

## 3b. Tham chiếu Jira Cloud API

Tra cứu từ OpenAPI spec chính thức ngày 19/07/2026. Đánh dấu `[DOC]` = có trong spec, `[CĐ]` = nguồn cộng đồng / KB, `[SUY]` = suy luận.

### 3b.1 Trình tự khởi động, chạy một lần rồi cache

| # | Gọi | Lấy được |
|---|---|---|
| 1 | `GET /rest/api/3/project/VT` | `style` (`classic`/`next-gen`), `simplified` |
| 2 | `GET /rest/api/3/issue/createmeta/VT/issuetypes` | Issue type + cờ `subtask`, `hierarchyLevel` |
| 3 | `GET /rest/api/3/issue/createmeta/VT/issuetypes/{id}` | Field tạo được cho từng type |
| 4 | `GET /rest/api/3/field` | Đối chiếu id field sprint |
| 5 | Probe một Task đã gắn epic | Xác nhận epic dùng `parent` hay `Epic Link` |

**Bước 1 phải chạy trước.** `GET /rest/api/3/issue/createmeta` (không có path con) đã `deprecated: true` — không dùng.

### 3b.2 Phân tầng: `parent` đa nghĩa

```
Task.fields.parent      → Epic
Sub-task.fields.parent  → Task
```

`parent` luôn nghĩa là "đúng một tầng trên". Nó trỏ vào đâu do `issuetype` gửi kèm quyết định. `[SUY]` — ghép từ hai tài liệu Atlassian, **không** có một câu khẳng định trực tiếp cho trường hợp ba tầng. **Phải probe thực tế trước khi ship.**

- `parent` nhận `{"key": "VT-100"}` hoặc `{"id": "10412"}`. **Ưu tiên `id`** vì key đổi khi issue chuyển project `[DOC]`
- "Epic Link" deprecated nhưng **chưa gỡ**, vẫn xuất hiện trong `/field` và createmeta → **không thể dùng sự hiện diện của nó để đoán chế độ** `[DOC]`
- JQL **không đổi**: `"Epic Link" = VT-1` vẫn chạy. Đừng sửa JQL theo `[DOC]`
- Phát hiện chế độ: đọc một Task đã gắn epic với `?fields=parent,customfield_XXXXX`, xem field nào có giá trị `[SUY]`

### 3b.3 Sub-task không mang epic và sprint

**Không gửi epic, không gửi sprint khi tạo sub-task.** Jira lấy cả hai từ task cha `[CĐ]`. Sub-task đọc sprint có thể trả rỗng ([JRACLOUD-70352](https://jira.atlassian.com/browse/JRACLOUD-70352)).

Không có tài liệu chuẩn nào nói rõ chuyện này — code phòng thủ cả hai chiều: đọc có thể rỗng, ghi có thể bị từ chối.

### 3b.4 Field id dò động

| Field | Cách tìm |
|---|---|
| Sprint | `schema.custom === "com.pyxis.greenhopper.jira:gh-sprint"` `[CĐ]` |
| Story points | Quét createmeta tìm `name` là `Story point estimate` **hoặc** `Story Points` |

**Cả hai story point field đều có `schema.custom` giống hệt nhau** (`...customfieldtypes:float`) nên không phân biệt được bằng schema `[CĐ]`. Phải khớp theo `name`. Vì createmeta chỉ trả field thực sự dùng được cho tổ hợp project + type nên **chỉ một trong hai xuất hiện**.

- Company-managed dùng **Story Points**
- Team-managed dùng **Story point estimate**

Ghi sai field thì Jira **không báo lỗi**, chỉ là board và burndown rỗng.

**Ghi sprint** (chỉ áp dụng cho Task, không phải sub-task): giá trị là **số nguyên trần**, không phải mảng `[CĐ]`. An toàn hơn là bỏ qua custom field, tạo issue xong rồi gọi `POST /rest/agile/1.0/sprint/{id}/issue` `[DOC]`.

### 3b.5 Danh sách sprint

`GET /rest/agile/1.0/board/13/sprint?state=active` — **không** deprecated `[DOC]`.

Jira sắp xếp theo **state rồi vị trí backlog**, không theo ngày `[DOC]`. Nên "sprint cuối trong danh sách" không phải sprint hiện tại. Thuật toán chọn:

1. Bỏ sprint có `startDate > hôm nay`
2. **Giữ sprint có `endDate >= hôm nay`** ← chỗ này làm việc chính, sprint tồn đọng chưa đóng có `endDate` đã qua
3. Còn nhiều thì sắp `startDate` giảm dần, hoà thì `id` giảm dần
4. Không còn cái nào thì lấy `startDate` lớn nhất

`startDate`/`endDate`/`completeDate` **có thể không tồn tại** tuỳ state — sprint tương lai không có ngày nào `[DOC]`. Luôn kiểm tra trước khi đọc.

Hiện `endDate` trên UI để người dùng tự kiểm tra lựa chọn tự động.

### 3b.6 Tìm kiếm JQL

`POST /rest/api/3/search` **đã bị gỡ 01/05/2025** `[DOC]`. Dùng `/rest/api/3/search/jql`.

- **`fields` mặc định chỉ trả `id`**, khác với `GET issue`. Luôn truyền danh sách field rõ ràng `[DOC]`
- **Phân trang bằng `nextPageToken`, không dùng `isLast`** — `isLast` có bug ([JRACLOUD-94648](https://jira.atlassian.com/browse/JRACLOUD-94648)) không bao giờ chuyển `true`, vòng lặp chạy mãi `[CĐ]`. Chặn thêm trường hợp token lặp lại
- Không còn `total` và `startAt`. Đếm số lượng: `POST /rest/api/3/search/approximate-count`, chỉ để hiển thị
- JQL phải **có giới hạn** — `order by key desc` trơ trọi bị từ chối
- Kết quả **eventually consistent**, dùng `reconcileIssues` khi cần đọc ngay sau khi ghi

### 3b.6b Nhất quán trễ — đã gây lỗi ba lần

`search/jql` **eventually consistent**. Bất cứ thứ gì vừa ghi lên Jira đều có thể vắng mặt trong truy vấn ngay sau đó, và biểu hiện luôn giống nhau: **thao tác báo thành công nhưng giao diện không đổi**.

Đã dính ba lần:

| Lần | Truy vấn | Triệu chứng |
|---|---|---|
| 1 | `getWorklogs` | Log giờ xong, thanh dung lượng đứng im |
| 2 | `getWorklogs` | Log lần đầu trong khoảng thì hụt, lần sau thì được |
| 3 | `getBoard` | Subtask vừa tạo không hiện, phải đổi sprint rồi quay lại |

**Quy tắc:** mọi truy vấn `search/jql` đọc lại thứ vừa ghi **phải** truyền `reconcileIssues` kèm **id số** của issue liên quan.

- Tham số phải **lặp lại từng id**, không nối bằng dấu phẩy — dạng phẩy trả `400 Failed to convert`
- Nhận **id**, không nhận key. `createIssue` có sẵn id, nhớ chuyển lên tới UI
- `router.refresh()` không mang được tham số → phải điều hướng kèm `?reconcile=<id>`

### 3b.7 Tám endpoint Agile sắp bị gỡ

Hết hạn **sau 01/11/2026** — khoảng 3,5 tháng nữa `[DOC]`. Gồm `GET /rest/agile/1.0/sprint/{id}/issue` và các endpoint liệt kê issue khác.

**Viết thẳng theo bản mới `/rest/software/1.0/`** cùng đường dẫn, phân trang `nextPageToken`. Bản mới mặc định trả đủ field nên không dính lỗi `id`-only.

Vẫn an toàn: `GET /rest/agile/1.0/board/{id}/sprint` và `POST /rest/agile/1.0/sprint/{id}/issue`.

### 3b.8 Worklog

`POST /rest/api/3/issue/{key}/worklog`

- Gửi **đúng một** trong `timeSpent` (`"3h 20m"`) hoặc `timeSpentSeconds`, không gửi cả hai `[DOC]`
- **`started` định dạng `2021-01-17T12:34:00.000+0000`** — bắt buộc mili giây, offset **không** dấu hai chấm, **không** dùng `Z`. `toISOString()` của JS sinh ra `Z` và **sẽ hỏng** `[CĐ]`. Phải tự format
- `comment` là **ADF** ở v3. Nếu chỉ ghi text thuần thì `/rest/api/2/...` đơn giản hơn nhiều và không deprecated `[DOC]`
- **`notifyUsers=false`** khi log hàng loạt, nếu không sẽ spam watcher `[DOC]`
- Không có giới hạn nào cấm log vào task cha `[DOC]`. Vấn đề là **cộng dồn**: worklog sub-task không dồn lên cha, nên nếu report cộng cả hai sẽ **đếm gấp đôi** `[CĐ]`

### 3b.9 Transition

- Liệt kê: `GET /rest/api/3/issue/{key}/transitions?expand=transitions.fields`
- Thực thi: `POST` cùng path, body `{"transition": {"id": "5"}}`, **trả 204 không có body** `[DOC]`
- **`to.id` là id của status, không phải id transition** `[DOC]`. Ngay cả tên transition cũng gây hiểu nhầm — ví dụ chính thức có transition tên `"Close Issue"` nhưng `to` lại là `"In Progress"`
- Khớp theo `to.name` / `to.id`, không khớp theo tên transition
- Kiểm `isAvailable` trước khi hiện, kiểm `hasScreen` để biết có phải gửi kèm field bắt buộc không

### 3b.10 Hai thứ phải kiểm chứng trước khi ship

1. **`parent` ở cả hai tầng** — probe một Task đã gắn epic trên VT
2. **`style` của project VT** — `Story point estimate` thường là dấu hiệu **team-managed**, nhưng board scrum lại gợi ý company-managed. Chạy bước 1 của 3b.1 để biết chắc, vì nó quyết định cả cách gắn epic lẫn field story point

## 4. API nội bộ (Next Route Handlers)

| Route | Việc |
|---|---|
| `GET /api/jira/issues` | Query issue theo sprint/epic/status/assignee |
| `GET /api/jira/meta` | Danh sách project, issue type, sprint, epic, board |
| `GET /api/jira/parents` | Task cấp trên để gắn sub-task, lọc theo sprint hoặc toàn project |
| `POST /api/jira/issues` | Tạo issue mới |
| `POST /api/jira/worklog` | Ghi worklog (validate bước tối thiểu, `started` mặc định 09:00 + offset) |
| `GET /api/jira/worklog` | Worklog theo khoảng ngày → dùng cho report + thống kê |
| `POST /api/jira/transition` | Đổi status issue |
| `PUT /api/jira/assignee` | Tự nhận task về mình |
| `POST /api/jira/search` | Chạy JQL tự do cho màn Tìm & nhận task |
| `GET /api/jira/transitions` | Transition khả dụng của một issue → dropdown status |
| `POST /api/ai/generate` | AI sinh title/description/DoD (không kèm tiền tố) |
| `GET/POST /api/drafts` | CRUD draft trong SQLite |
| `GET/POST /api/settings` | Đọc/ghi settings |

## 5. Các giai đoạn

**Phase 0 — Thăm dò instance** *(làm trước tiên, chỉ vài script nhỏ)*
Chạy trình tự 3b.1 với token thật, in ra `style` của VT, danh sách issue type kèm cờ `subtask`, field id của sprint và story point, và probe `parent` trên một Task đã gắn epic. **Chốt xong hai câu hỏi ở 3b.10 rồi mới code tiếp** — sai chỗ này thì mọi thứ phía sau xây trên nền sai.

**Phase 1 — Nền móng**
Scaffold Next.js + Tailwind + shadcn, schema SQLite, màn Settings, Jira client wrapper, nút Test connection chạy được.

**Phase 2 — Task Board + Log work**
Đọc issue từ Jira, chọn sprint theo mốc start/end, filter, log work từng task với stepper + preset, thanh dung lượng ngày, xử lý cuối tuần / OT.

**Phase 3 — Report + thống kê** ✅
Sinh report từ worklog thật, copy, template sửa được, bảng 7 ngày, thống kê sprint, xuất CSV.

Template dùng một tập con nhỏ của mustache, tự viết thay vì kéo thư viện: report chỉ cần đúng một khối lặp, mà một engine cho phép chạy biểu thức tuỳ ý là rủi ro trong ô người dùng tự sửa. Biến hỗ trợ: `{{date}}` `{{next_date}}` `{{total}}` `{{count}}` `{{name}}` `{{sprint}}`, và trong khối `{{#issues}}…{{/issues}}` có `{{key}}` `{{summary}}` `{{time}}` `{{hours}}`.

CSV có BOM UTF-8 để Excel không vỡ font tiếng Việt.

**Phase 4 — Tìm & nhận task** ✅
Ba chế độ tìm, tự assign, lưu preset JQL.

**Phase 5 — AI Composer + tạo issue** ✅
Tích hợp AI, màn composer, lưu draft, tạo issue thật với sprint/epic/parent.

**Đã đổi engine: Gemini → Claude Code CLI.** Model Gemini bị khai tử theo lịch
của Google — `gemini-2.5-flash` vẫn nằm trong danh sách `/models` nhưng gọi thì
trả 404 *"no longer available to new users"* — và free tier còn trả 200 kèm body
không phải JSON. Giờ chạy bằng binary `claude` trên máy: không API key, cùng một
binary với module Review code, và model lấy từ ô `claude_model` trong Settings
(trống = mặc định của CLI). `/api/ai/models` bỏ hẳn, CLI tự biết model của nó.

**Phase 6 — Hoàn thiện**
Dark mode, keyboard shortcut, xử lý lỗi Jira rõ ràng, README hướng dẫn chạy.

## 6. Môi trường đã xác nhận

- **Jira Cloud**: `https://your-company.atlassian.net`
- **Project**: `ABC` — Tên project · **Board**: `13` (scrum board, dùng Agile API `/rest/agile/1.0/board/13/sprint`)
- **Sprint** đặt tên dạng `VT Sprint 63` → tiền tố title `[spt 63]`
- **Định mức**: 8h/ngày thường, cuối tuần không tính định mức. Công ty chỉ kiểm tổng giờ, không kiểm mốc giờ
- Custom field id của Story Points / Epic Link khác nhau tuỳ instance → app tự dò qua `/rest/api/3/field` rồi cache, không hardcode `customfield_10016` như tool cũ
- Nhiều sprint cùng mở do PM không complete → chọn sprint theo `startDate`/`endDate`, không dùng `openSprints()`
