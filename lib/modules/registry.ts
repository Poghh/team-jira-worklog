/**
 * The catalogue of optional modules.
 *
 * One manifest per module, and nothing here touches the database — so this file
 * is safe to import from client components (the Settings toggles and the nav
 * both read it directly). Adding a module is adding an entry plus its route
 * under `app/m/<id>/`; nav, Settings and the route guard all derive from here.
 */
export type ModuleId = 'progress' | 'ios-publish' | 'releases' | 'branches' | 'sdk-release'

export interface ModuleManifest {
  id: ModuleId
  name: string
  /** Emoji shown in nav and the Settings list. */
  icon: string
  description: string
  nav: { href: string; label: string }
  /** 'ready' = built; 'wip' = registered but the route is still a placeholder. */
  status: 'ready' | 'wip'
  /** Names the SQLite tables the module owns, shown as a hint in Settings. */
  tables?: string[]
  /** Short note when the module needs configuration before it works. */
  configHint?: string
}

export const MODULES: ModuleManifest[] = [
  {
    id: 'progress',
    name: 'Feature report',
    icon: '📈',
    description:
      'Ghi tiến độ feature theo Document / Implement / Fix, xuất text đúng mẫu để gửi group.',
    nav: { href: '/m/progress', label: 'Feature report' },
    status: 'ready',
    tables: ['progress_reports', 'progress_items'],
  },
  {
    id: 'ios-publish',
    name: 'iOS publish',
    icon: '🍎',
    description:
      'Submit build đã upload lên TestFlight external testing qua App Store Connect API — khỏi vào TestFlight bấm tay.',
    nav: { href: '/m/ios-publish', label: 'iOS publish' },
    status: 'ready',
    tables: ['ios_publish_log'],
    configHint: 'cần issuer · key · .p8',
  },
  {
    id: 'sdk-release',
    name: 'Release SDK',
    icon: '📦',
    description:
      'Chạy lệnh release iOS SDK ngay trong app: gợi ý tên version từ nhánh và lịch sử release, fetch + chuyển nhánh + fast-forward main, rồi theo dõi log tới lúc xong. Trong lúc build có canh remote — ai đó release trước thì dừng sớm thay vì mất 40 phút; hỏng rồi thì chỉ ra từng bước dọn.',
    nav: { href: '/m/sdk-release', label: 'Release SDK' },
    status: 'ready',
    tables: ['sdk_release_run'],
    configHint: 'cần đường dẫn 2 repo · ~/.netrc',
  },
  {
    id: 'branches',
    name: 'Nhánh & ghi chú',
    icon: '⑂',
    description:
      'Nhánh của từng task đang ở đâu và có lưu ý gì — kanban theo vòng đời nhánh, ghi chú gắn thẳng vào issue Jira và hiện luôn trên task board. Cảnh báo khi nhánh đi trước mà ticket đứng yên.',
    nav: { href: '/m/branches', label: 'Nhánh & ghi chú' },
    status: 'ready',
    tables: ['task_notes'],
  },
  {
    id: 'releases',
    name: 'Releases',
    icon: '🚀',
    description:
      'Task của nhiều team đang ở môi trường nào — bảng Kanban theo môi trường, nhập tay.',
    nav: { href: '/m/releases', label: 'Releases' },
    status: 'ready',
    tables: ['release_tasks'],
  },
]

export function getModule(id: string): ModuleManifest | undefined {
  return MODULES.find((m) => m.id === id)
}
