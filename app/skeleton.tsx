/**
 * Shared skeleton pieces.
 *
 * These mirror the real layout closely enough that nothing jumps when the data
 * arrives — a spinner in the middle of an empty page would reflow everything.
 */

export function Shimmer({ className = '' }: { className?: string }) {
  return <div className={'animate-pulse rounded bg-surface-2 ' + className} />
}

/**
 * `lines` là số dòng chữ của header thật: board có ba (nhãn sprint, tiêu đề,
 * câu mô tả), report có hai. Chiều cao từng dòng và khoảng cách giữa chúng lấy
 * đúng của bản thật — đo được 67px cho ba dòng — nên lúc dữ liệu về thì phần
 * dưới không bị đẩy lên hay xuống.
 */
export function HeaderSkeleton({
  lines = 3,
  withPicker = true,
}: {
  lines?: 2 | 3
  withPicker?: boolean
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
      <div>
        <Shimmer className="h-[13px] w-56" />
        <Shimmer className="mt-[3px] h-7 w-40" />
        {lines > 2 && <Shimmer className="mt-1 h-[19px] w-72" />}
      </div>
      {withPicker && (
        <div className="flex flex-col items-end gap-1.5">
          <Shimmer className="h-2.5 w-24" />
          <Shimmer className="h-[30px] w-[240px]" />
        </div>
      )}
    </header>
  )
}

export function CardSkeleton({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <section className={'rounded-[9px] border border-line bg-surface p-[17px] ' + className}>
      <Shimmer className="mb-3 h-2.5 w-32" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: lines }, (_, i) => (
          <Shimmer key={i} className="h-3.5" />
        ))}
      </div>
    </section>
  )
}

export function SideSkeleton() {
  return (
    <aside className="flex flex-col gap-3.5">
      <CardSkeleton lines={7} />
      <CardSkeleton lines={4} />
    </aside>
  )
}

export function LoadingNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
      <span className="inline-block size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
      {children}
    </p>
  )
}
