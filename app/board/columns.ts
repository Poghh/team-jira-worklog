/**
 * Bộ cột của bảng task, khai báo đúng **một** lần.
 *
 * Ba hàng dùng chung nó — hàng tiêu đề cột, hàng task cha, hàng task con — và
 * cả ba phải trùng khít nhau, vì toàn bộ giá trị của bố cục này nằm ở chỗ quét
 * dọc một cột là ra câu trả lời. Chép ba bản `grid-template-columns` giống nhau
 * là ba cơ hội để chúng lệch đi theo thời gian, mà lệch 2px thì cột không còn
 * là cột nữa.
 *
 * Cột cố định chứ không co theo nội dung: đó là thứ sửa đúng lỗi của bố cục cũ.
 * Ở đó cụm control bên phải rộng tự nhiên 525px và cột tiêu đề là
 * `minmax(0,1fr)`, nên mọi phần hẹp đi dồn hết vào tiêu đề — đo được 1280px
 * còn 68px, 1100px còn 0. Ở đây tiêu đề có sàn 240px và cụm ghi giờ tự xuống
 * dòng trong ô của nó.
 */
export const BOARD_COLS =
  "grid items-center gap-2.5 " +
  // Dưới 1280px: bỏ hai cột Ngày và SP. Bảy cột không vừa bề ngang đó — đo
  // được tiêu đề chỉ còn 105px, tức đọc được chừng một chữ rưỡi. Bỏ Ngày và
  // SP trước vì chúng là thứ liếc qua, còn trạng thái và nút ghi giờ là thứ
  // dùng; hai cột đó vẫn sửa được trong dialog Chi tiết.
  "grid-cols-[172px_minmax(240px,1fr)_140px_96px_236px] " +
  "xl:grid-cols-[172px_minmax(240px,1fr)_140px_118px_62px_96px_236px]";

/** Ô chỉ hiện từ 1280px trở lên — xem {@link BOARD_COLS}. */
export const WIDE_ONLY = "hidden xl:flex";
