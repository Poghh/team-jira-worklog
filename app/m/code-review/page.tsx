import { connection } from 'next/server'

import { ModuleGate } from '@/lib/modules/gate'
import { checkClaude } from '@/lib/modules/code-review/claude'
import { getReviewConfig } from '@/lib/modules/code-review/config'
import { ensureTicker, tick } from '@/lib/modules/code-review/runner'
import { listItems } from '@/lib/modules/code-review/store'
import { isModuleEnabled } from '@/lib/modules/state'

import { CodeReview } from './review'

export default async function CodeReviewPage() {
  await connection()
  if (!isModuleEnabled('code-review')) return <ModuleGate id="code-review">{null}</ModuleGate>

  // Bring every round up to date before drawing it: a review may have
  // finished while nobody had this page open.
  ensureTicker()
  await tick()

  const cfg = getReviewConfig()
  const claude = await checkClaude()

  return (
    <ModuleGate id="code-review">
      <CodeReview
        claude={claude}
        repos={cfg.repos}
        runner={{ concurrency: cfg.concurrency, claudeBin: cfg.claudeBin, model: cfg.model, globalRules: cfg.globalRules }}
        items={listItems('open')}
      />
    </ModuleGate>
  )
}
