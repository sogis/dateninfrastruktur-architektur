import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { lock, root, safePath } from './sources.mts'

const fullSha = /^[a-f0-9]{40}$/
const safeRemote = /^https:\/\/github\.com\/sogis\/[a-z0-9-]+[.]git$/
const branch = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/
const git = (directory: string, ...args: string[]) => execFileSync('git', ['-C', directory, ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
})

function checkout(directory: string, remote: string, revision: string, approvedBranch: string) {
  assert(safeRemote.test(remote) && fullSha.test(revision) && branch.test(approvedBranch))
  mkdirSync(directory, { recursive: true })
  git(directory, 'init', '-q')
  git(directory, 'remote', 'add', 'origin', remote)
  git(directory, 'fetch', '--no-tags', '--depth=1', 'origin', revision)
  git(directory, 'checkout', '-q', '--detach', revision)
  assert.equal(git(directory, 'rev-parse', 'HEAD').trim(), revision)
}

function inventory(directory: string) {
  const manifest = JSON.parse(git(directory, 'show', lock.workspace + ':repositories.json'))
  const entries = manifest.repositories.filter(entry => entry.profile === 'core' && entry.id !== 'architecture')
  assert.deepEqual(entries.map(entry => entry.id).sort(), Object.keys(lock.products).sort())
  return { workspace: manifest.workspace, entries }
}

function observe(directory: string, manifest) {
  const rows = [['workspace', manifest.workspace.remote, manifest.workspace.branch],
    ...manifest.entries.map(entry => [entry.id, entry.remote, entry.branch])]
  const commits = Object.fromEntries(rows.map(([id, remote, name]) => {
    assert(safeRemote.test(remote) && branch.test(name))
    const ref = 'refs/heads/' + name
    const response = git(directory, 'ls-remote', '--heads', remote, ref).trim().split('\t')
    assert(response.length === 2 && fullSha.test(response[0]) && response[1] === ref, 'Cannot observe approved branch')
    return [id, response[0]]
  }))
  const { workspace, ...products } = commits
  return { schema_version: 1, workspace, products }
}

function prepare() {
  const workspaceRemote = process.env.DI_WORKSPACE_REMOTE ?? ''
  assert(safeRemote.test(workspaceRemote), 'Approved workspace read remote is required')
  const temp = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'di-frozen-ci-'))
  checkout(temp, workspaceRemote, lock.workspace, 'main')
  const manifest = inventory(temp)
  assert.equal(workspaceRemote, manifest.workspace.remote, 'Workspace URL differs from pinned inventory')
  const arch = join(temp, 'dateninfrastruktur-architektur')
  git(temp, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', root, arch)
  git(arch, 'checkout', '--quiet', '--detach', git(root, 'rev-parse', 'HEAD').trim())
  for (const entry of manifest.entries) {
    assert.equal(safePath(entry.path), basename(entry.path))
    checkout(join(temp, entry.path), entry.remote, lock.products[entry.id], entry.branch)
  }
  console.log(arch)
}

async function run() {
  const workspace = join(root, '..')
  const manifest = inventory(workspace)
  const { beginStatus, finishStatus, normalizedEvent, reconcile } = await import('./reconcile.mts')
  const event = process.env.GITHUB_EVENT_NAME ?? ''
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'))
  assert(['pull_request', 'repository_dispatch', 'workflow_dispatch', 'schedule'].includes(event))
  const status = join(root, '.runtime/status.json')
  const { product, pr, head, publish_probe = 'false' } = payload.inputs ?? {}
  if (event === 'workflow_dispatch' && (product || pr || head || publish_probe === 'true')) {
    assert(Object.keys(payload.inputs).every(key => ['head', 'pr', 'product', 'publish_probe'].includes(key)))
    assert(['false', 'true'].includes(publish_probe))
    const publish = publish_probe === 'true'
    assert(!publish || process.env.DI_HOSTED_PROBE_ENABLED === 'true' && process.env.GITHUB_REF === 'refs/heads/main',
      'Hosted counterprobe is not enabled')
    assert(typeof pr === 'string' && /^[1-9][0-9]{0,8}$/.test(pr), 'Invalid product PR number')
    const entry = manifest.entries.find(row => row.id === product)
    assert(entry, 'Product PR repository is not in the approved inventory')
    const signal = normalizedEvent({ repo: product, branch: entry.branch, sha: head }, 'pull_request')
    const directory = join(workspace, entry.path)
    const ref = 'refs/pull/' + pr + '/head'
    const observeProductPr = () => {
      const rows = git(directory, 'ls-remote', entry.remote, ref).trim().split('\t')
      assert(rows.length === 2 && fullSha.test(rows[0]) && rows[1] === ref, 'Product PR ref unavailable')
      return { ...lock, products: { ...lock.products, [product]: rows[0] } }
    }
    assert.equal(observeProductPr().products[product], head, 'Product PR head differs from the requested SHA')
    git(directory, 'fetch', '--no-tags', '--depth=1', 'origin', ref)
    assert.equal(git(directory, 'rev-parse', 'FETCH_HEAD').trim(), head, 'Product PR head changed during fetch')
    const candidate = { ...lock, products: { ...lock.products, [product]: head } }
    const result = await reconcile(candidate, signal, publish ? status : join(root, '.runtime/product-pr-status.json'),
      observeProductPr, { source: 'diagnostic-product-pr' })
    console.log(JSON.stringify({ scope: 'unprivileged-product-pr', result }))
    if (result.comparison_status !== 'VERIFIED') process.exitCode = 1
    return
  }
  if (event === 'pull_request') {
    const pr = payload.pull_request
    assert(Number.isSafeInteger(payload.number) && payload.number > 0 &&
      fullSha.test(pr.base.sha) && fullSha.test(pr.head.sha) && pr.base.sha === git(root, 'rev-parse', 'HEAD').trim(),
    'Untrusted PR metadata mismatch')
    const githubRepo = process.env.GITHUB_REPOSITORY ?? ''
    assert.equal(githubRepo, 'sogis/dateninfrastruktur-architektur')
    const remote = 'https://github.com/' + githubRepo + '.git'
    git(root, 'fetch', '--no-tags', '--depth=1', remote, 'refs/pull/' + payload.number + '/head')
    assert.equal(git(root, 'rev-parse', 'FETCH_HEAD').trim(), pr.head.sha, 'PR head changed during observation')
    const paths = git(root, 'diff', '--name-only', '-z', pr.base.sha, pr.head.sha, '--').split('\0').filter(Boolean)
    const dataOnly = /^(?:src\/(?:model|views)\/.+[.]c4|docs\/.+[.]md|README[.]md)$/
    if (!paths.every(path => dataOnly.test(safePath(path)))) {
      console.log(JSON.stringify({ scope: 'trusted-base-only', candidate: pr.head.sha, disposition: 'PENDING_REVIEW' }))
      process.exitCode = 1
      return
    }
    const tmp = mkdtempSync(join(tmpdir(), 'di-pr-data-'))
    try {
      const { modelAt, checkArchitecture } = await import('./model.mts')
      const { verifyArchitecture } = await import('./validate-model.mts')
      cpSync(join(root, 'src'), join(tmp, 'src'), { recursive: true })
      for (const path of paths.filter(path => path.startsWith('src/'))) {
        const tree = git(root, 'ls-tree', pr.head.sha, '--', path).trim()
        const file = join(tmp, path)
        if (!tree) {
          rmSync(file)
        } else {
          assert(/^100644 blob [a-f0-9]{40}\s/.test(tree), 'Untrusted model file type')
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, git(root, 'show', pr.head.sha + ':' + path))
        }
      }
      execFileSync(join(root, 'node_modules/.bin/likec4'), ['validate', join(tmp, 'src')], { stdio: 'inherit' })
      const model = await modelAt(join(tmp, 'src'))
      checkArchitecture(model)
      const report = await verifyArchitecture(undefined, model)
      assert(report.results.every(rule => rule.configuration === 'checked'))
      console.log(JSON.stringify({ scope: 'unprivileged-model-data', candidate: pr.head.sha, disposition: 'STATIC_CHECKED' }))
    } finally {
      rmSync(tmp, { recursive: true })
    }
    return
  }
  const signal = normalizedEvent(event === 'repository_dispatch' ? payload.client_payload : null, event)
  if (event === 'repository_dispatch') {
    assert(payload.sender?.login === 'sogis-di-architecture-dispatch[bot]', 'Dispatch sender is not the approved App')
  }
  const observed = observe(workspace, manifest)
  if (signal.repo) {
    assert(observed.products[signal.repo] === signal.sha, 'Dispatch is superseded or not on the approved branch')
  }
  try {
    for (const entry of manifest.entries) {
      const directory = join(workspace, entry.path)
      git(directory, 'fetch', '--no-tags', '--depth=60', 'origin',
        'refs/heads/' + entry.branch + ':refs/remotes/origin/' + entry.branch)
      assert.equal(git(directory, 'cat-file', '-t', observed.products[entry.id]).trim(), 'commit')
    }
    if (observed.workspace !== lock.workspace) {
      git(workspace, 'fetch', '--no-tags', '--depth=60', 'origin', observed.workspace)
    }
  } catch (error) {
    const started = beginStatus(status, observed, undefined, 'remote-branches')
    finishStatus(status, started, { comparison_status: 'NOT_VERIFIABLE', error: 'Frozen commit unavailable' })
    process.exitCode = 1
    return
  }
  const result = await reconcile(observed, signal, status, () => observe(workspace, manifest), { source: 'remote-branches' })
  console.log(JSON.stringify(result))
  if (result.comparison_status === 'VIOLATION' || result.comparison_status === 'SUPERSEDED') process.exitCode = 1
}

if (process.argv[2] === 'prepare') prepare()
else if (process.argv[2] === 'run') await run()
else throw new Error('Use the prepared CI prepare/run entrypoints')
