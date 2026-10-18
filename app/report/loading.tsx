import { CardSkeleton, HeaderSkeleton, LoadingNote, Shimmer, SideSkeleton } from '../skeleton'

export default function ReportLoading() {
  return (
    <>
      <HeaderSkeleton lines={2} />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_296px]">
        <div className="flex flex-col gap-4">
          <section className="rounded-[9px] border border-line bg-surface p-[17px]">
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <Shimmer className="h-2.5 w-32" />
              <div className="flex gap-1.5">
                <Shimmer className="h-[29px] w-36" />
                <Shimmer className="h-[29px] w-16" />
              </div>
            </div>
            <Shimmer className="h-[168px]" />
          </section>

          <CardSkeleton lines={7} />
          <LoadingNote>Đang đọc worklog từ Jira…</LoadingNote>
        </div>

        <SideSkeleton />
      </div>
    </>
  )
}
