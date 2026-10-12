# Jira Logwork

Ứng dụng chạy ngay trên máy bạn để **log giờ lên Jira** và **dựng daily report**,
không cần mở Jira từng task. Thay cho Chrome extension `jira-daily-tool` cũ.

Không cần biết lập trình — làm theo các bước dưới đây một lần là xong, những ngày sau
chỉ cần 2 lệnh để mở lại. Ở những bước khác nhau giữa hai hệ điều hành, hướng dẫn tách
riêng **🍎 macOS** và **🪟 Windows** — bạn chỉ cần đọc phần của máy mình.

---

## Hướng dẫn cài đặt từng bước (cho designer, QC, người không rành kỹ thuật)

Tổng thời gian lần đầu: khoảng **15–20 phút**.

> **"Cửa sổ lệnh" là gì?** Là cửa sổ để gõ lệnh — trên macOS gọi là **Terminal**, trên Windows
> dùng **Command Prompt**. Trong hướng dẫn này, mỗi khi thấy khung lệnh màu xám, bạn
> **copy nguyên dòng đó, dán vào cửa sổ lệnh rồi bấm Enter**.

### Bước 1 — Chuẩn bị 3 thứ (giống nhau cho mọi máy)

1. **Email đăng nhập Jira** của bạn (email công ty bạn dùng để vào Jira).
2. **Địa chỉ Jira của công ty** — mở Jira trên trình duyệt, copy phần đầu địa chỉ,
   ví dụ `https://tencongty.atlassian.net`.
3. **Jira API token** — một "mật khẩu riêng cho ứng dụng":
   1. Mở https://id.atlassian.com/manage-profile/security/api-tokens (đăng nhập nếu được hỏi).
   2. Bấm **Create API token**, đặt tên bất kỳ (vd `jira-logwork`), chọn thời hạn, bấm **Create**.
   3. Bấm **Copy** và dán tạm vào ghi chú. **Token chỉ hiện một lần** — đóng cửa sổ là không xem lại được
      (mất thì tạo cái mới).

> ⚠️ Token này là của riêng bạn. Không gửi cho ai, không dùng chung token của người khác.

### Bước 2 — Cài Node.js (chỉ làm một lần)

Node.js là "động cơ" để chạy ứng dụng. Mở https://nodejs.org và tải bản **LTS** (nút ghi "LTS").

#### 🍎 macOS

1. Mở file vừa tải (`.pkg`) → bấm **Continue** đến hết → **Install**, nhập mật khẩu máy nếu được hỏi.
2. Mở **Terminal**: bấm `⌘ Command` + `Space`, gõ `Terminal`, Enter.
3. Gõ lệnh kiểm tra rồi Enter:

   ```bash
   node -v
   ```

   Thấy một dòng như `v22.x.x` hoặc `v24.x.x` (số đầu **từ 20 trở lên**) là được.
   Nếu báo `command not found`, tắt hẳn Terminal (`⌘ Q`) rồi mở lại và thử lần nữa.

#### 🪟 Windows

1. Mở file vừa tải (`.msi`) → bấm **Next** đến hết → **Install**, chọn **Yes** nếu Windows hỏi quyền.
   Ở màn **Tools for Native Modules** cứ để trống ô tick, bấm **Next**.
2. Mở **Command Prompt**: bấm phím `⊞ Windows`, gõ `cmd`, Enter.
   (Mở cửa sổ **mới** sau khi cài xong — cửa sổ mở từ trước sẽ chưa nhận Node.js.)
3. Gõ lệnh kiểm tra rồi Enter:

   ```bat
   node -v
   ```

   Thấy một dòng như `v22.x.x` hoặc `v24.x.x` (số đầu **từ 20 trở lên**) là được.
   Nếu báo `'node' is not recognized…`, đóng Command Prompt, mở lại và thử lần nữa;
   vẫn không được thì khởi động lại máy.

### Bước 3 — Lấy ứng dụng về máy

Bạn sẽ nhận được một file **`jira-logwork-xxxxxxxx.zip`** từ người trong team
(hoặc link repo GitHub nếu được cấp quyền).

#### 🍎 macOS

1. Bấm đúp file zip để giải nén.
2. Kéo thư mục vừa giải nén vào **Documents** (Tài liệu) và đổi tên thành **`jira-logwork`**.

#### 🪟 Windows

1. Bấm chuột phải vào file zip → **Extract All…** (Giải nén tất cả) → **Extract**.
2. Chuyển thư mục vừa giải nén vào **Documents** (Tài liệu) và đổi tên thành **`jira-logwork`**.
   Kiểm tra: mở thư mục đó phải thấy ngay file `package.json` (không bị lồng thêm một thư mục cùng tên bên trong).

<details>
<summary>Nếu bạn được cấp quyền repo GitHub (không bắt buộc)</summary>

macOS (Terminal):

```bash
cd ~/Documents
git clone https://github.com/tankadev/team-jira-worklog.git jira-logwork
```

Windows (Command Prompt, cần cài Git từ https://git-scm.com trước):

```bat
cd %USERPROFILE%\Documents
git clone https://github.com/tankadev/team-jira-worklog.git jira-logwork
```

</details>

### Bước 4 — Mở cửa sổ lệnh tại thư mục ứng dụng

#### 🍎 macOS

Mở **Terminal**, gõ `cd ` (chữ cd **và một dấu cách**), rồi **kéo thư mục `jira-logwork` từ Finder
thả vào cửa sổ Terminal** — đường dẫn tự điền — bấm Enter.

Hoặc nếu bạn để đúng chỗ như Bước 3, chỉ cần dán:

```bash
cd ~/Documents/jira-logwork
```

#### 🪟 Windows

Cách dễ nhất: mở thư mục `jira-logwork` trong **File Explorer**, bấm vào **thanh địa chỉ** phía trên,
xoá hết, gõ `cmd` rồi Enter — Command Prompt mở sẵn đúng thư mục.

Hoặc mở Command Prompt rồi dán:

```bat
cd %USERPROFILE%\Documents\jira-logwork
```

### Bước 5 — Cài các thành phần của ứng dụng (chỉ làm lần đầu)

Giống nhau cho mọi máy — trong cửa sổ lệnh vừa mở ở Bước 4:

```bash
npm install
```

Chờ khoảng **1–3 phút**. Màn hình chạy nhiều chữ, có thể có chữ `warn` màu vàng — **bình thường**,
không cần làm gì. Xong khi dấu nhắc lệnh hiện lại.

### Bước 6 — Mở ứng dụng

```bash
npm run dev
```

Chờ đến khi thấy dòng:

```
- Local:        http://localhost:3000
```

Mở trình duyệt (Chrome, Safari, Edge…) và vào **http://localhost:3000**.

- 🍎 macOS: có thể giữ `⌘ Command` rồi bấm vào link trong Terminal.
- 🪟 Windows: có thể giữ `Ctrl` rồi bấm vào link. Nếu Windows hiện hộp **Windows Defender Firewall**
  hỏi về Node.js, bấm **Cancel** cũng được — ứng dụng chỉ chạy trong máy bạn.

> ⚠️ **Để nguyên cửa sổ lệnh trong lúc dùng app.** Đóng cửa sổ = tắt ứng dụng.
> Có thể thu nhỏ cho gọn.

### Bước 7 — Kết nối với Jira của bạn (giống nhau cho mọi máy)

1. Trong ứng dụng, bấm **Settings** (menu bên trái).
2. Ở khung **Kết nối Jira**, điền:

   | Ô | Điền gì | Ví dụ |
   |---|---|---|
   | **Jira base URL** | Địa chỉ Jira công ty (Bước 1) | `https://tencongty.atlassian.net` |
   | **Email** | Email đăng nhập Jira của bạn | `ten.ban@congty.com` |
   | **API token** | Token vừa tạo ở Bước 1 | `ATATT3x…` |
   | **Project key** | Chữ viết tắt của dự án | `VT` |
   | **Board id** | Số của board | `4493` |

   **Tìm Project key và Board id:** mở board của team trên Jira, nhìn thanh địa chỉ trình duyệt, ví dụ
   `https://tencongty.atlassian.net/jira/software/c/projects/`**`VT`**`/boards/`**`4493`**
   → Project key là **`VT`**, Board id là **`4493`**. Không chắc thì hỏi leader.

3. Kéo xuống cuối trang, bấm **Lưu settings**.
4. Kéo lên lại, bấm **Test connection**. Thấy **"Kết nối OK · Tên của bạn"** là xong 🎉

> Phải bấm **Lưu settings trước** rồi mới **Test connection** — nút test kiểm tra cấu hình đã lưu.

### Bước 8 — Nếu board của bạn dùng chung với team khác (hỏi leader nếu không chắc)

Ở khung **Team trên board** trong Settings, bấm **Dò từ board** → app tự điền
label, tiền tố và bộ lọc sprint của team → bấm **Lưu settings**.
Board chỉ có một team thì bỏ qua bước này.

**Xong!** Vào **Task board** để xem task được giao và bắt đầu log giờ.

---

## Dùng hằng ngày

Mỗi lần bật máy muốn dùng app: mở ứng dụng theo phần của máy bạn bên dưới, rồi vào
**http://localhost:3000**. Cấu hình đã lưu từ lần trước, không phải điền lại.

### 🍎 macOS

Mở **Terminal** rồi dán lần lượt:

```bash
cd ~/Documents/jira-logwork
npm run dev
```

**Tắt ứng dụng:** bấm vào cửa sổ Terminal, nhấn `Control` + `C` (hoặc đóng cửa sổ).

### 🪟 Windows

Mở thư mục `jira-logwork` trong File Explorer → gõ `cmd` vào thanh địa chỉ → Enter, rồi dán:

```bat
npm run dev
```

**Tắt ứng dụng:** bấm vào cửa sổ Command Prompt, nhấn `Ctrl` + `C`; nếu được hỏi
`Terminate batch job (Y/N)?` thì gõ `Y` rồi Enter (hoặc đóng cửa sổ).

### Cập nhật lên bản mới

Khi nhận được file zip bản mới:

1. Tắt ứng dụng (xem cách tắt ở trên).
2. Giải nén bản mới (như Bước 3), **copy thư mục `data` từ bản cũ sang bản mới** — trong đó là cấu hình
   và token của bạn. Không copy thì phải điền lại Settings.
3. Mở cửa sổ lệnh tại thư mục bản mới (như Bước 4), chạy lại `npm install` một lần rồi `npm run dev`.

### Màn hình chính

| Màn | Dùng để |
|---|---|
| **Task board** | Xem subtask đang giao cho bạn, log giờ, đổi trạng thái. |
| **Tìm & nhận task** | Tìm task theo sprint / cả project, nhận task về mình. |
| **Task mới** | Mô tả bằng lời, AI viết sẵn title + mô tả + DoD, tạo task trên Jira. |
| **Report** | Daily report từ giờ đã log, bấm copy để gửi; xem thống kê tuần / sprint, xuất CSV. |
| **Settings** | Kết nối Jira, AI, quy tắc giờ, bật/tắt module. |

> **Task mới** dùng AI của Google (Gemini) — muốn dùng thì tạo key miễn phí tại
> https://aistudio.google.com/apikey, dán vào ô **API key** ở khung **Google Gemini** trong Settings,
> **Lưu settings** rồi bấm **Test Gemini**. Không dùng thì bỏ qua.

---

## Gặp lỗi?

### Lỗi giống nhau trên mọi máy

| Hiện tượng | Cách xử lý |
|---|---|
| `ENOENT … package.json` khi chạy `npm` | Cửa sổ lệnh chưa đứng đúng thư mục — làm lại Bước 4. |
| Báo cổng 3000 đã được dùng (`Port 3000 is in use`) | App tự chạy ở cổng khác — mở đúng link `Local: http://localhost:300x` hiện trong cửa sổ lệnh. |
| Trình duyệt báo **không kết nối được** `localhost` | Ứng dụng chưa chạy hoặc cửa sổ lệnh đã bị đóng — chạy lại `npm run dev`. |
| **Test connection** báo **401** | Email hoặc token sai, hoặc token hết hạn. Tạo token mới (Bước 1), dán lại, **Lưu settings**, test lại. Email phải đúng email đăng nhập Jira. |
| **Test connection** báo **404** / không tìm thấy | Jira base URL sai — chỉ để phần đầu, vd `https://tencongty.atlassian.net`, không có `/jira/...` phía sau. |
| Task board trống | Bạn chưa có subtask trong sprint đang chạy — đổi bộ lọc sang **Mọi sprint**; hoặc ô **Label của team** đang lọc mất task (xem [Board dùng chung cho nhiều team](#board-dùng-chung-cho-nhiều-team)). |
| Trang cứ hiện **"Đang tải…"** rất lâu, bấm không ăn | Tắt app, chạy lại `npm run dev`, tải lại trang. |
| Vẫn không được | Mở http://localhost:3000/api/health, chụp màn hình gửi cho người hỗ trợ. **Đừng gửi** API token. |

### 🍎 Chỉ trên macOS

| Hiện tượng | Cách xử lý |
|---|---|
| `command not found: node` hoặc `npm` | Chưa cài Node.js (Bước 2), hoặc cần tắt hẳn Terminal (`⌘ Q`) rồi mở lại. |
| `npm install` báo lỗi đỏ có chữ `gyp` / `better-sqlite3` / `xcrun` | Máy thiếu công cụ của Apple. Chạy `xcode-select --install`, bấm **Install** trong cửa sổ hiện ra, chờ xong rồi chạy lại `npm install`. |

### 🪟 Chỉ trên Windows

| Hiện tượng | Cách xử lý |
|---|---|
| `'node' is not recognized…` hoặc `'npm' is not recognized…` | Chưa cài Node.js (Bước 2), hoặc cần mở **cửa sổ Command Prompt mới**; vẫn lỗi thì khởi động lại máy. |
| `npm.ps1 cannot be loaded because running scripts is disabled` | Bạn đang ở **PowerShell**, không phải Command Prompt. Mở **Command Prompt** (gõ `cmd`) như Bước 4 và chạy lại. |
| `npm install` báo lỗi đỏ có chữ `gyp` / `better-sqlite3` / `Visual Studio` | Máy thiếu công cụ build. Chạy lại file cài Node.js (`.msi`) → **Change/Modify** → **tick ô "Automatically install the necessary tools"** ở màn *Tools for Native Modules* → cài xong (lâu, có cửa sổ đen tự chạy) thì mở Command Prompt mới và chạy lại `npm install`. |
| Đường dẫn có dấu tiếng Việt / dấu cách gây lỗi lạ | Để thư mục ở `Documents\jira-logwork` đúng như Bước 3, tránh đặt trong thư mục có tên tiếng Việt có dấu. |

### Bảo mật

- Thư mục **`data`** chứa token Jira của bạn. **Không gửi thư mục này** cho ai, không đưa lên Drive/chat.
- Muốn chia sẻ app cho đồng nghiệp: nhờ người có quyền chạy `./share.sh` trên macOS (xem [Chia sẻ cho người khác](#chia-sẻ-cho-người-khác)) —
  file zip tạo ra đã tự loại token. Người nhận tự tạo token riêng.

---

## Vài quy ước đã cài sẵn

- **Chỉ log giờ vào Subtask.** Task cha chỉ để gom nhóm.
- **Định mức 8h/ngày thường**, T7 và CN không tính định mức nhưng giờ log vào vẫn cộng tổng.
- **Point 1 = 1–2h, 2 = 4h, 3 = 1–2 ngày.** Tối đa 3 point. App chỉ cảnh báo khi vượt, không bao giờ chặn.
- **Task cha không tự cộng point** — app tính sẵn tổng point các task con để bạn tự điền vào cha.
- **Tiền tố title** `[Mobile]` `[BE]` … chọn được nhiều cái, thứ tự bấm là thứ tự ghép. `[SPT-69]` tự suy từ sprint.
- **Start date và due date là bắt buộc** khi tạo task — nút *Tạo trên Jira* không bật cho tới khi chọn đủ.

Tất cả sửa được trong Settings.

---

# Dành cho developer

## Cấu hình bằng file (thay cho điền Settings)

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

Rồi `npm run dev`, mở http://localhost:3000 → **Settings** → **Test connection**.

> `.env.local` chỉ dùng để nạp lần đầu. Sau đó mọi cấu hình nằm trong SQLite và sửa thẳng
> trong màn Settings, không cần restart. Muốn nạp lại từ file thì xoá `data/app.db`.
> Yêu cầu **Node.js 20.9 trở lên**; bản này phát triển trên Node 23.

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

## Xử lý sự cố (chi tiết)

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
