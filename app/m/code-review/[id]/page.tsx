import { notFound } from 'next/navigation'
import { connection } from 'next/server'

import { ModuleGate } from '@/lib/modules/gate'
import { checkClaude } from '@/lib/modules/code-review/claude'
import { getRepo } from '@/lib/modules/code-review/config'
import { type GithubAccess, checkAccess } from '@/lib/modules/code-review/github'
import { ensureTicker, tick } from '@/lib/modules/code-review/runner'
import { getItem } from '@/lib/modules/code-review/store'
import { isModuleEnabled } from '@/lib/modules/state'

import { ReviewDetail } from './detail'

export default async function ReviewItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  await connection()
  if (!isModuleEnabled('code-review')) return <ModuleGate id="code-review">{null}</ModuleGate>

  const { id } = await params
  const { tab } = await searchParams
  const item = getItem(Number(id))
  if (!item) notFound()

  ensureTicker()
  await tick()

  const repo = item.repoId ? getRepo(item.repoId) : undefined
  // Decides the UI: send / reply / resolve when the token may comment, Copy
  // only when it may not. Cached for ten minutes; "Kiểm tra lại" forces it.
  const access: GithubAccess =
    item.kind === 'pr' && item.prNumber && repo?.githubRepo
      ? await checkAccess(repo.githubRepo, item.prNumber)
      : { read: false, write: false, reason: '' }
  return (
    <ModuleGate id="code-review">
      <ReviewDetail
        item={item}
        repoName={repo?.name ?? ''}
        githubRepo={repo?.githubRepo ?? ''}
        claude={await checkClaude()}
        initialTab={tab === 'discussion' ? 'discussion' : 'review'}
        access={access}
      />
    </ModuleGate>
  )
}
