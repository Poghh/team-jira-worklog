/**
 * The code-review module may review and comment — nothing else.
 *
 * Run: npx tsx tests/code-review-guard.mts
 *
 * The GitHub token it uses can usually merge, push and delete branches, and
 * the code it hands to Claude was written by someone else. These assertions
 * pin the allowlists in lib/modules/code-review/guard.ts so that widening one
 * is a deliberate, visible change.
 */
import {
  DISALLOWED_TOOLS,
  ISOLATION_FLAGS,
  assertGitArgs,
  assertGithubRequest,
  assertGraphql,
  reviewEnv,
} from '@/lib/modules/code-review/guard'

let n = 0
let bad = 0
const ok = (fn: () => void, m: string) => {
  n++
  try {
    fn()
  } catch (e) {
    bad++
    console.log('FAIL (threw)', m, '—', (e as Error).message)
  }
}
const no = (fn: () => void, m: string) => {
  n++
  try {
    fn()
    bad++
    console.log('FAIL (allowed)', m)
  } catch {}
}
const R = '/repos/atthetalk/viptalk-ios-x'

// GitHub: reads pass, only the four comment/review endpoints may be written.
ok(() => assertGithubRequest('GET', `${R}/pulls?state=open`), 'list PRs')
ok(() => assertGithubRequest('POST', `${R}/pulls/12/comments`, { body: 'x' }), 'inline comment')
ok(() => assertGithubRequest('POST', `${R}/pulls/12/comments/99/replies`, { body: 'x' }), 'reply')
ok(() => assertGithubRequest('POST', `${R}/issues/12/comments`, { body: 'x' }), 'PR conversation comment')
ok(() => assertGithubRequest('POST', `${R}/pulls/12/reviews`, { event: 'COMMENT' }), 'review: comment')
ok(() => assertGithubRequest('POST', `${R}/pulls/12/reviews`, { event: 'REQUEST_CHANGES' }), 'review: request changes')
no(() => assertGithubRequest('POST', `${R}/pulls/12/reviews`, { event: 'APPROVE' }), 'review: approve (can trigger auto-merge)')
no(() => assertGithubRequest('POST', `${R}/pulls/12/reviews`, {}), 'review without event (= pending/unknown)')
no(() => assertGithubRequest('PUT', `${R}/pulls/12/merge`), 'merge PR')
no(() => assertGithubRequest('PATCH', `${R}/pulls/12`, { state: 'closed' }), 'close PR')
no(() => assertGithubRequest('DELETE', `${R}/git/refs/heads/feature`), 'delete branch')
no(() => assertGithubRequest('POST', `${R}/git/refs`, {}), 'create ref')
no(() => assertGithubRequest('PUT', `${R}/contents/a.swift`, {}), 'commit a file')
no(() => assertGithubRequest('POST', `${R}/merges`, {}), 'merge branches')
no(() => assertGithubRequest('POST', `${R}/pulls/12/update-branch`, {}), 'update PR branch')
no(() => assertGithubRequest('PATCH', `${R}/pulls/comments/99`, {}), 'edit someone\'s comment')
no(() => assertGithubRequest('DELETE', `${R}/pulls/comments/99`), 'delete a comment')
no(() => assertGithubRequest('POST', `${R}/pulls/12/comments/../../merge`, {}), 'path trick')

ok(() => assertGraphql('query($o: String!) { viewer { login } }'), 'graphql query')
ok(() => assertGraphql('mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }'), 'resolve thread')
ok(() => assertGraphql('mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }'), 'unresolve thread')
no(() => assertGraphql('mutation { mergePullRequest(input: { pullRequestId: "x" }) { clientMutationId } }'), 'graphql merge')
no(() => assertGraphql('mutation { enablePullRequestAutoMerge(input: { pullRequestId: "x" }) { clientMutationId } }'), 'graphql auto-merge')
no(() => assertGraphql('mutation { deleteRef(input: { refId: "x" }) { clientMutationId } }'), 'graphql delete ref')
no(() => assertGraphql('mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } mergePullRequest(input: { pullRequestId: "x" }) { clientMutationId } }'), 'graphql smuggled second mutation')

// Git run by the app.
ok(() => assertGitArgs(['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*']), 'fetch all')
ok(() => assertGitArgs(['fetch', 'origin', '+refs/pull/7/head:refs/review/pr-7', '+refs/heads/main:refs/remotes/origin/main']), 'fetch PR')
ok(() => assertGitArgs(['worktree', 'add', '--detach', '--force', '/tmp/x', 'abc']), 'worktree add')
ok(() => assertGitArgs(['diff', '-U3', 'a', 'b']), 'diff')
for (const cmd of ['push', 'commit', 'reset', 'checkout', 'merge', 'rebase', 'branch', 'tag', 'remote', 'config', 'update-ref', 'pull', 'clean']) {
  no(() => assertGitArgs([cmd, 'origin']), `git ${cmd}`)
}
no(() => assertGitArgs(['fetch', 'origin', 'feature:main']), 'fetch into a local branch')
no(() => assertGitArgs(['fetch', 'origin', '+refs/heads/x:refs/heads/x']), 'fetch into refs/heads')
no(() => assertGitArgs(['worktree', 'move', 'a', 'b']), 'worktree move')

// Claude on untrusted code.
for (const c of ['git push', 'git commit', 'git reset', 'gh', 'curl', 'rm']) {
  n++
  if (!DISALLOWED_TOOLS.includes(`Bash(${c}:*)`)) {
    bad++
    console.log('FAIL not denied:', c)
  }
}
n++
if (!ISOLATION_FLAGS.join(' ').includes('--setting-sources user') || !ISOLATION_FLAGS.includes('--strict-mcp-config') || !ISOLATION_FLAGS.includes('dontAsk')) {
  bad++
  console.log('FAIL isolation flags', ISOLATION_FLAGS)
}
const env = reviewEnv({ PATH: '/bin', GITHUB_TOKEN: 't', GH_TOKEN: 't', SSH_AUTH_SOCK: '/s', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'x' } as unknown as NodeJS.ProcessEnv)
n++
if (env.GITHUB_TOKEN || env.GH_TOKEN || env.SSH_AUTH_SOCK || env.PATH !== '/bin') {
  bad++
  console.log('FAIL env still carries secrets', env)
}
const cfg = Object.fromEntries(
  Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]),
)
n++
if (cfg['protocol.allow'] !== 'never' || cfg['credential.helper'] !== '' || cfg.x) {
  bad++
  console.log('FAIL git config in review env', cfg)
}

console.log(bad ? `${bad}/${n} failed` : `code-review guard: ${n} ok`)
process.exit(bad ? 1 : 0)
