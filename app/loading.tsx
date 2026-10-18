import { BOARD_COLS, WIDE_ONLY } from './board/columns'
import { HeaderSkeleton, LoadingNote, Shimmer } from './skeleton'

/**
 * Khung chờ của board, dựng theo đúng bố cục thật.
 *
 * Bản trước còn là bố cục hai cột của đời panel: một cột nội dung bị cap
 * 1340px và một cột phải 296px. Board giờ chạy hết bề ngang và không có cột
 * phải nào, nên khi dữ liệu về thì mọi thứ nhảy ngang vài trăm pixel và cả một
 * khối bên phải biến mất — đúng kiểu nhảy mà skeleton sinh ra để tránh.
 *
 * Nên bản này mượn lại chính {@link BOARD_COLS} của bảng. Chép tay một bộ cột
 * thứ hai là để nó lệch dần theo thời gian; dùng chung thì mốc cột của khung
 * chờ và của bảng thật không bao giờ rời nhau.
 */
export default function BoardLoading() {
  return (
    <>
      {/* `withPicker={false}`: ô chọn ngày đã chuyển vào dải tổng quan bên
          dưới, không còn nằm ở góc phải header. */}
      <HeaderSkeleton lines={3} withPicker={false} />

      {/* Cùng cái cờ `data-wide` mà trang thật bật — xem luật
          `main:has([data-wide])` trong globals.css. Thiếu nó thì khung chờ
          rộng 1340px còn bảng thật rộng cả màn hình. */}
      <div data-wide hidden />

      <StripSkeleton />

      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        <Shimmer className="h-[31px] w-[232px]" />
        <Shimmer className="h-[31px] w-[118px]" />
        <Shimmer className="h-[31px] w-[150px]" />
        <Shimmer className="h-[31px] w-[164px]" />
        <Shimmer className="h-[31px] w-[164px]" />
        <Shimmer className="h-[31px] w-[140px]" />
      </div>

      <div className="flex flex-col gap-4">
        <EpicSkeleton rows={[4, 3]} />
        <EpicSkeleton rows={[3]} />
      </div>

      <LoadingNote>Đang tải task và worklog từ Jira…</LoadingNote>
    </>
  )
}

/** Dải tổng quan ngang — xem `board/overview-strip.tsx`. */
function StripSkeleton() {
  return (
    <section className="mb-3 flex flex-wrap items-stretch rounded-[9px] border border-line bg-surface">
      <div className="flex items-center border-r border-line px-3 py-2">
        <div className="flex flex-col items-start gap-1">
          <Shimmer className="h-[15px] w-24" />
          <Shimmer className="h-[30px] w-[196px]" />
        </div>
      </div>

      <Seg value="w-[118px]" />
      <Seg label="w-28" value="w-[140px]" />
      <Seg value="w-[164px]" />

      {/* Dải ngày: cùng `min-w-[460px] flex-1` như bản thật, nên lúc hẹp nó
          rơi xuống một hàng riêng y hệt. */}
      <div className="flex min-w-[460px] flex-1 items-end gap-[3px] border-l border-line px-3 py-2">
        {Array.from({ length: 14 }, (_, i) => (
          <Shimmer key={i} className="h-[60px] flex-1" />
        ))}
      </div>

      {/* Ô này có ba dòng — chip ngày thiếu và dòng "n ngày nghỉ" — nên nó
          mới là ô quyết chiều cao 73px của cả dải, không phải ô nào khác. */}
      <Seg label="w-20" value="w-[76px]" extra="w-[112px]" className="border-l border-line" />
    </section>
  )
}

function Seg({
  label = 'w-16',
  value,
  extra,
  className = '',
}: {
  label?: string
  value: string
  /** Dòng thứ ba, chỉ ô "Ngày chưa đủ" có. */
  extra?: string
  className?: string
}) {
  return (
    <div
      className={
        'flex shrink-0 flex-col justify-center gap-1 border-r border-line px-3 py-2 last:border-r-0 ' +
        className
      }
    >
      <Shimmer className={'h-3.5 ' + label} />
      <Shimmer className={(extra ? 'h-5 ' : 'h-[29px] ') + value} />
      {extra && <Shimmer className={'h-3.5 ' + extra} />}
    </div>
  )
}

function HeadShimmer({ className }: { className: string }) {
  return <div className={'h-2 animate-pulse rounded bg-line ' + className} />
}

function EpicShimmer({ className }: { className: string }) {
  return <div className={'animate-pulse rounded bg-epic/20 ' + className} />
}

/** Một dải epic và cái bảng dưới nó; `rows` là số task con của từng task cha. */
function EpicSkeleton({ rows }: { rows: number[] }) {
  return (
    <div>
      {/* Vệt trên dải epic không dùng <Shimmer>: component đó đã mang sẵn
          `bg-surface-2`, và thêm một class nền thứ hai thì cái nào thắng là do
          thứ tự trong stylesheet quyết, không phải thứ tự trong chuỗi. */}
      <div className="mb-2 mt-1 flex flex-wrap items-center gap-2 rounded-[7px] rounded-l-none border-l-[3px] border-epic bg-epic-soft py-1.5 pl-2.5 pr-3">
        <EpicShimmer className="h-[23px] w-[52px]" />
        <EpicShimmer className="h-3 w-[72px]" />
        <EpicShimmer className="h-3 flex-1" />
        <EpicShimmer className="h-3 w-[160px]" />
      </div>

      <section className="rounded-[9px] border border-line bg-surface [&>*:last-child]:rounded-b-[9px]">
        <div
          className={
            'rounded-t-[9px] border-b border-line bg-surface-2 px-3 py-1.5 ' + BOARD_COLS
          }
        >
          {/* Không dùng <Shimmer>: nền của nó là `bg-surface-2`, trùng đúng
              nền của hàng tiêu đề, nên bảy vệt chữ biến mất và hàng này đọc ra
              là một dải xám trống. */}
          <HeadShimmer className="w-8" />
          <HeadShimmer className="w-10" />
          <HeadShimmer className="w-14" />
          <HeadShimmer className={WIDE_ONLY + ' w-8'} />
          <HeadShimmer className={WIDE_ONLY + ' w-4'} />
          <HeadShimmer className="w-16 justify-self-end" />
          <HeadShimmer className="w-10 justify-self-end" />
        </div>

        {rows.map((children, i) => (
          <div key={i}>
            <RowSkeleton parent />
            {Array.from({ length: children }, (_, j) => (
              <RowSkeleton key={j} />
            ))}
          </div>
        ))}
      </section>
    </div>
  )
}

/**
 * Một hàng, cao đúng 39px như hàng thật.
 *
 * Chiều cao đó do ô ghi giờ quyết định — control trong đó cao `h-[26px]` —
 * nên ô giả ở đây cũng phải `h-[26px]`, không phải một vệt mảnh.
 */
function RowSkeleton({ parent = false }: { parent?: boolean }) {
  return (
    <div
      className={
        'border-b border-line border-l-[3px] px-3 py-1.5 last:border-b-0 ' +
        (parent ? 'border-l-blue bg-blue-soft/60 ' : 'border-l-transparent ') +
        BOARD_COLS
      }
    >
      {parent ? (
        <span className="flex items-center gap-1">
          <Shimmer className="h-[18px] w-[46px]" />
          <Shimmer className="h-3 w-[64px]" />
        </span>
      ) : (
        <span className="ml-1.5 flex items-center border-l border-line-strong pl-14">
          <Shimmer className="h-3 w-[66px]" />
        </span>
      )}

      <Shimmer className={parent ? 'h-3 w-[62%]' : 'h-3 w-[78%]'} />
      <Shimmer className="h-[22px] w-[88px]" />
      <Shimmer className={WIDE_ONLY + ' h-[22px] w-[104px]'} />
      <Shimmer className={WIDE_ONLY + ' h-6 w-[26px] justify-self-end'} />
      <Shimmer className="h-3 w-[58px] justify-self-end" />
      <Shimmer className={(parent ? 'w-[140px] h-3' : 'w-[186px] h-[26px]') + ' justify-self-end'} />
    </div>
  )
}
