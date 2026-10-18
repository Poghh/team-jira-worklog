import { BOARD_COLS, WIDE_ONLY } from "./columns";

/**
 * Khung bảng: một thẻ, một hàng tiêu đề cột, rồi mọi nhóm bên trong.
 *
 * Hàng tiêu đề là thứ làm cột trở thành cột. Không có nó thì ô thứ tư chỉ là
 * một chip ngày trôi nổi, và người đọc phải suy ra từ nội dung xem cột đó là
 * gì — mà suy sai một lần là thôi không tin cả bảng.
 *
 * `sticky` để nó còn ở đó khi cuộn: một sprint có vài chục task con, và cuộn
 * được nửa màn hình là mất hết tên cột.
 */
export function BoardTable({ children }: { children: React.ReactNode }) {
  return (
    /* Không `overflow-hidden`.
     *
     * Popover ngày, popover point và menu trạng thái đều là phần tử tuyệt đối
     * nằm trong bảng, nên cắt tràn là cắt luôn chúng — hộp "VT-2622 · NGÀY"
     * mất hẳn hai nút ở đáy. Đúng lỗi đã gặp ở panel trước đó.
     *
     * Bo góc vì vậy phải do hàng đầu và hàng cuối tự lo: hàng tiêu đề có nền
     * riêng, và `[&>*:last-child]` bo bất kỳ thứ gì rơi xuống cuối. */
    <section className="rounded-[9px] border border-line bg-surface [&>*:last-child]:rounded-b-[9px]">
      <div
        className={
          "sticky top-0 z-[4] rounded-t-[9px] border-b border-line bg-surface-2 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.07em] text-ink-3 " +
          BOARD_COLS
        }
      >
        <span>Key</span>
        <span>Task</span>
        <span>Trạng thái</span>
        <span className={WIDE_ONLY}>Ngày</span>
        <span className={WIDE_ONLY + " justify-end"}>SP</span>
        <span className="text-right">Hôm nay · tổng</span>
        <span className="text-right">Ghi giờ</span>
      </div>

      {children}
    </section>
  );
}
