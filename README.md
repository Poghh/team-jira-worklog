# Jira Logwork

Công cụ chạy local để log giờ lên Jira và dựng daily report. Thay cho Chrome extension `jira-daily-tool` cũ.

## Cần gì trước khi chạy

- **Node.js 20.9 trở lên** (`node -v`). Bản này phát triển trên Node 23.
- **Jira API token** — tạo tại https://id.atlassian.com/manage-profile/security/api-tokens
- **Google API key** — tạo tại https://aistudio.google.com/apikey (chỉ cần nếu muốn dùng AI sinh nội dung task)

## Chạy lần đầu

```bash
npm install
cp .env.local.example .env.local
```

Mở `.env.local`, điền vào:

```
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_EMAIL=email-cua-ban@congty.com     ← email tài khoản Atlassian của BẠN
JIRA_API_TOKEN=                        ← token của BẠN, không dùng chung
GOOGLE_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
JIRA_PROJECT_KEY=ABC
JIRA_BOARD_ID=1
GITHUB_TOKEN=                          ← chỉ cần nếu bật module "Nhánh & ghi chú"
```

Rồi chạy:

```bash
npm run dev
```

Mở http://localhost:3000 → vào **Settings** → bấm **Test connection**. Ra tên bạn là xong.

> `.env.local` chỉ dùng để nạp lần đầu. Sau đó mọi cấu hình nằm trong SQLite và sửa thẳng
> trong màn Settings, không cần restart. Muốn nạp lại từ file thì xoá `data/app.db`.

## Chạy bản production

```bash
npm run build
npm start
```

## Kiểm tra

```bash
npm test
```

Chạy các quy tắc thuần của bảng Nhánh & ghi chú — cột nào cho nhánh nào, đọc
mã ticket từ tên nhánh và từ ghi chú bản build, múi giờ của build number, link
Jira trỏ sang site khác. Không cần mạng và không đụng vào `data/app.db`.

Kèm theo là luật gọi lại của Jira client, kiểm bằng một HTTP server dựng tại
chỗ trên cổng 8791: read gặp 5xx thì thử lại, gặp 4xx thì thôi, và **write thì
không bao giờ thử lại** — một POST worklog gọi lại là số giờ bị ghi hai lần.

### Bảng Nhánh & ghi chú lấy dữ liệu lúc nào

| Chu kỳ | Gọi gì | Nguồn |
|---|---|---|
| 3 phút, và mỗi lần tab được xem lại | render lại server component | Jira — trạng thái ticket |
| 12 phút, và mỗi lần tab được xem lại | `refreshPrsAction` | GitHub — PR của các nhánh **đã có card** |
| 30 phút, và mỗi lần tab được xem lại | `checkBuildsAction` | App Store Connect — bản build |
| **6 phút** khi có bản build đã upload mà chưa giao cho tester | `checkBuildsAction` | như trên — xem bên dưới |
| chỉ khi bấm ↻ Quét GitHub | `quickScanAction` | GitHub — dò nhánh mới + đo containment |
| chỉ khi bấm ↻ Bản build | `checkBuildsAction(fresh)` | App Store Connect — bỏ qua cả cache 5 phút |

Một bug có thể phải sửa ở **cả hai repo** — SDK Rust và app iOS — và hai nửa đi
với nhịp riêng: PR bên SDK merge từ hai tuần trước trong khi nửa iOS còn đang
viết. 9 trên 51 ticket đang ở dạng đó. Card vì vậy giữ một **danh sách phía**
(`sides`), mỗi repo một phía với nhánh, PR và trạng thái môi trường riêng.

Cột của card đi theo **phía đi xa nhất**, và **bản build là bằng chứng mạnh
nhất**: một bản build của môi trường nào chỉ tồn tại được khi code đã lên môi
trường đó, nên nó nói về cả card. Không dùng "phía chậm nhất" — nhánh ở đây
không bị xoá cho tới khi release, nên một repo giữ nhánh bỏ đi (PR đã đóng,
commit không bao giờ vào) rất lâu sau khi thay đổi đã đi ké nhánh khác; đọc nó
thành "nửa này còn dở" là đọc rác thành việc đang làm.

Bản build không chia theo phía: build là của app iOS và nó mang theo bản SDK đã
pin, nên một bản build cho cả card.

Chỉ các cột **`đã build`** đòi ticket ở trạng thái test. Merge chưa phải là ship
— ở mọi môi trường, không riêng môi trường đầu — nên cột `đã merge` không cảnh
báo, nếu không nó sẽ báo lệch cho ticket đang chạy đúng quy trình.

Card nhiều repo nhận **mép trái chia màu** và một chip cho mỗi repo ở header, để
phân biệt ngay khi lướt bảng.

Sửa được bằng tay, mỗi thứ theo đúng chiều của nó — và mỗi thứ **một chỗ duy
nhất**, không có ô nào làm trùng việc ô nào: **nhánh** ghim theo từng repo (cùng một tên nhánh có ở cả hai repo, app ghép theo commit mới nhất nên
ghép sai được), **pull request** ghim theo từng (repo, môi trường), **bản build**
điền theo từng môi trường. Xoá trống là trả lại cho app tự chọn.

Pull request của card có thể **ghim theo từng môi trường** trong ô Sửa card. Cần
vì việc của team này vào bằng nhánh `resolve`: GitHub gắn bản merge cho nhánh
resolve, nên trong `associatedPullRequests` của nhánh feature chỉ còn lần thử
đầu đã bị đóng và app chọn nhầm nó. Ghim chỉ giữ **số** — trạng thái vẫn do
GitHub trả lời, hỏi bằng `fetchPrsByNumber`, nên một PR ghim vẫn tự chuyển
sang merged. Xoá trống để trả lại cho app tự chọn.

**Không gọi được Jira khác với Jira không có ticket.** `getIssueStatuses` từng
nuốt mọi lỗi thành kết quả rỗng, rồi ghi từng key vào bộ nhớ `missing` — nên
mất VPN một lần là bảng ghi "Jira không thấy" lên mọi card (một khẳng định sai
về Jira của khách) và **thôi hỏi Jira về những key đó suốt 30 phút**, kể cả sau
khi mạng đã về. Giờ chỉ HTTP 400 — Jira trả lời rằng key không tồn tại — mới
được ghi là `missing`; lỗi kết nối thì ném lên, bảng ghi "chưa gọi được Jira"
và hiện nút **↻ Thử lại Jira**.

Mỗi môi trường trỏ tới một app trên App Store Connect, và tên app là **text tự
do** — nó buộc phải khớp chính xác tên bên Apple. Gõ sai, hoặc thêm môi trường
vào pipeline mà chưa thêm app tương ứng vào module iOS publish, thì trước đây
môi trường đó **hỏng im lặng**: không bản build nào, không lời nào, không phân
biệt được với "chưa có bản build". Giờ ô cấu hình tự kiểm ngay (`✓ có
credential` / `✕ chưa có trong iOS publish`) và mỗi lần kiểm build cũng báo tên
môi trường bị bỏ qua kèm lý do.

Bản build về theo lịch của Apple chứ không theo lúc merge, và người ta thường
biết có bản mới **từ chat bot trước khi bảng kịp biết**. Nút **↻ Bản build** hỏi
ngay, bỏ qua cả cache 5 phút — nhịp nền vẫn giữ nguyên. Một lần kiểm ở trạng
thái bình thường tốn ~4 request trên giới hạn 3600/giờ, nên nút này gần như
miễn phí; cái đắt là nhịp nền nhân với số tab đang mở, và nó không đổi.

Nhịp kiểm bản build tự thích nghi. Nửa giờ là nhịp thường và giữ nguyên — bản
build không ra đủ dày để hỏi nhiều hơn. Nhưng khoảng giữa "đã upload" và "đã
giao cho tester" thì ngắn, và đó đúng là lúc bảng nói sai: ghi chú liệt kê
ticket được viết lúc public, nên trước đó bản build hiện ra mà không có nội
dung và không card nào được gắn. Thấy trạng thái khác `IN_BETA_TESTING` thì
hỏi lại sau 6 phút thay vì đợi hết nửa giờ. Sáu chứ không phải năm, vì danh
sách build được cache 5 phút — hỏi mỗi 5 phút chỉ đọc lại đúng bản cache.

`refreshPrsAction` là nửa rẻ của một lần quét: hỏi đích danh các ref đã có card
(một request GraphQL mỗi repo, ~2s cho 12 nhánh) thay vì đi bộ qua mọi nhánh của
repo. Nó **không** dò nhánh mới, không xoá card, không đo containment và không
đụng `syncedAt`. Cột vẫn nhúc nhích được vì `stageFor` đọc cả PR, nhưng nó không
thấy được một lần merge đã đáp xuống môi trường nào — đó là containment, phần bị
bỏ ra. Nên PR merge sẽ hiện là merged ngay, còn card đợi lần quét đầy đủ mới
chuyển cột.

### Log giờ lệch với due date

Một task đánh Done mang theo due date nói việc kết thúc lúc nào; một worklog đề
ngày sau đó nói việc vẫn đang chạy. Hai thứ không thể cùng đúng — thường là due
date chưa được dời, đôi khi là trạng thái đóng sớm, cũng có khi bạn đang đứng
nhầm ngày trên bảng. Trước đây không có gì trên màn hình nói chúng đang cãi nhau.

Cảnh báo chỉ áp cho task **đã Done**. Log vượt due date của task còn đang làm là
chuyện trễ hạn bình thường ở đây; báo cả ca đó sẽ chôn mất ca thật sự mâu thuẫn.

Tô vàng **cả dòng** khi ngày đó **thật sự đã có giờ log**, cộng vạch vàng dọc
bên trái và chip ngày cùng tông để chỉ ra lý do. Vàng chứ không đỏ: đỏ dành cho
deadline thật sự bị trễ, còn đây chỉ là hai sự thật đang cãi nhau và cái nào sai
thì bạn mới biết.

Điều kiện là **đã log**, không phải *đang đứng ở ngày đó*. Chọn một ngày ngoài
khoảng là cách người ta nhìn lại tuần trước hoặc nhìn tới ngày chưa điền — tô
màu cho việc đó biến lịch sprint thành cỗ máy sinh cảnh báo: bấm ngày quá khứ
nào cũng thấy nửa bảng sáng lên vì những chuyện không hề xảy ra. Đo trên bảng
thật: đứng ở 11/09 sau due date của mười task Done → **0 dòng vàng**; đứng ở
09/09 nơi `VT-698` (Done, due 08/09) có 8h log thật → **1 dòng**.

Nút Log không tô viền, chỉ nhắc trong tooltip trước khi bấm; bấm xong thì hiện
thêm một dòng nhắc, đúng một lần.

## Các màn hình

| Màn | Việc |
|---|---|
| **Task board** | Subtask đang giao cho bạn, nhóm theo task cha. Log giờ, đổi trạng thái. |
| **Tìm & nhận task** | Tìm theo sprint / toàn project / JQL tự do, rồi tự assign về mình. |
| **Task mới** | Mô tả bằng lời, Gemini dựng title + description + DoD, tạo issue thật trên Jira. |
| **Report** | Daily report từ worklog thật, copy được, thống kê tuần và sprint, xuất CSV. |
| **Settings** | Kết nối Jira / Gemini, quy tắc giờ, quy đổi point, tiền tố title, template report. |

## Vài quy ước đã cài sẵn

- **Chỉ log giờ vào Subtask.** Task cha chỉ để gom nhóm.
- **Định mức 8h/ngày thường**, T7 và CN không tính định mức nhưng giờ log vào vẫn cộng tổng.
- **Point 1 = 1–2h, 2 = 4h, 3 = 1–2 ngày.** Tối đa 3 point. App chỉ cảnh báo khi vượt, không bao giờ chặn.
- **Task cha không tự cộng point** — app tính sẵn tổng point các task con để bạn tự điền vào cha.
- **Tiền tố title** `[Mobile]` `[BE]` … chọn được nhiều cái, thứ tự bấm là thứ tự ghép. `[SPT-69]` tự suy từ sprint.
- **Start date và due date là bắt buộc** khi tạo task — nút *Tạo trên Jira* không bật cho tới khi chọn đủ.

Tất cả sửa được trong Settings.

## Board dùng chung cho nhiều team

Một project Jira có thể chứa nhiều board, mỗi board là một filter theo label — ví dụ project
`VT` có `CTALK-TEAM` (`labels in (ctalk)`) và `HIR-TEAM` cạnh nhau. Khi đó vào
**Settings → Team trên board** bấm **Dò từ board**; app đọc filter của board rồi điền sẵn ba giá trị:

| Giá trị | Tác dụng |
|---|---|
| **Label của team** | Lọc mọi màn hình theo label này, và tự gắn vào mọi task app tạo ra. Thiếu label thì task không hiện trên board của team. |
| **Tiền tố bắt buộc** | Luôn đứng đầu title, không bỏ chọn được — ví dụ `[CTALK]`. |
| **Lọc sprint theo tên** | Danh sách sprint của board chung có cả sprint team khác. Không lọc thì "sprint đang chạy" có thể trỏ nhầm sang sprint của team bạn. |

Task sai quy ước (thiếu label, thiếu tiền tố, thiếu ngày) hiện badge cảnh báo ngay trên board,
và sửa ngày được tại chỗ bằng chip ngày trên mỗi dòng.

Để trống cả ba nếu board chỉ có một team — app chạy y như cũ.

> **Story point khi field không nằm trên screen.** Có project company-managed để Story Points
> ngoài mọi screen và ước lượng qua backlog. Lúc đó `createmeta` không khai báo field, nên app
> lấy field ước lượng từ chính cấu hình board và ghi qua endpoint estimation của board — cần
> **Board id** trong Settings mới ghi được point.

## Cấu trúc

```
app/                 màn hình + route handler (đóng vai trò backend)
  api/               endpoint nội bộ: transitions, csv, health, models
  board/ find/ new/ report/ settings/
lib/
  jira/              client, meta, sprints, issues, worklog, find, create
  ai/gemini.ts       sinh nội dung task
  db/                schema + kết nối SQLite
  settings.ts        cấu hình, seed từ .env.local lần đầu
  time.ts            múi giờ, định dạng timestamp cho Jira
data/app.db          SQLite — settings, draft, template, preset  ⚠ chứa API token
PLAN.md              thiết kế + ghi chép kỹ thuật về Jira API
```

## Chia sẻ cho người khác

```bash
./share.sh
```

Tạo file zip đã loại sẵn `node_modules`, `.next`, `.env.local` và `data/`.

**Đừng bao giờ gửi kèm `data/app.db`** — file đó lưu Jira API token và Google API key
ở dạng chữ thường. Người nhận tự tạo token riêng của họ.

## Xử lý sự cố

**`Test connection` báo 401** — token sai hoặc đã hết hạn. Token Atlassian giờ có hạn tối đa 1 năm.
Kiểm tra ở https://id.atlassian.com/manage-profile/security/api-tokens, và email phải đúng email
đăng nhập Atlassian.

**Gemini báo 404 "no longer available"** — Google khai tử model theo lịch riêng của họ.
Đổi model trong Settings; xem danh sách gọi được tại http://localhost:3000/api/ai/models

**Board trống** — mặc định lọc theo sprint đang chạy. Nếu sprint đó bạn chưa có subtask nào,
board sẽ chỉ ra các Task cấp trên kèm nút **+ Task con**. Hoặc đổi bộ lọc sang *Mọi sprint*.
Nếu đã đặt **Label của team**, board còn lọc theo label đó — task được giao cho bạn nhưng thiếu
label sẽ không hiện. Xoá ô label trong Settings để xem tất cả.

**Sprint "đang chạy" sai team** — board dùng chung liệt kê cả sprint của team khác, và sprint đó
có thể đang `active` trong khi sprint của bạn còn `future`. Điền **Lọc sprint theo tên** trong
Settings (ví dụ `CTALK`).

**Đổi board mà màn hình vẫn như cũ** — field id và issue type được cache 24h theo project.
Bấm *Lưu settings* sẽ xoá cache đó; nếu vẫn lạ thì bấm **Làm mới** trên board.

**Kiểm tra nhanh toàn hệ thống** — http://localhost:3000/api/health trả về trạng thái DB,
cấu hình và kết nối Jira.
