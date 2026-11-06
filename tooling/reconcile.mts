import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { callCodex, validateProposal } from './codex-patch.mts'
import { verifyRun } from './flow-evidence.mts'
import { randomUUID } from 'node:crypto'
import { extractComposeFacts, extractGatewayFacts } from './facts.mts'
import { modelAt, modelFingerprint } from './model.mts'
import { lock, pinnedSource, resolveSources, root, safePath, sha256, workspaceRoot, type SourceLock } from './sources.mts'
import { selectChecks } from './select-checks.mts'
import { policyFindings, verifyArchitecture } from './validate-model.mts'

type Change = { repo_id: string; path: string }
type SourceSet = { workspace: string; products: Record<string, string> }
type Status = {
  generation: number; run_id: string; comparison_status: string
  verified_source_set: SourceSet | null; verified_at: string | null
  observed_source_set: SourceSet | null; observed_at: string | null
  coverage: string[]; observed_coverage: string[]
  comparison_source: 'local-heads' | 'remote-branches' | 'diagnostic-product-pr'
  error: string | null; proposal_ref: string | null
  evidence_sha256: string | null; relevant_input_sha256: string | null
  observed_input_sha256: string | null
  verified_model_sha256: string | null
  changes?: Change[]; findings?: ReturnType<typeof policyFindings>
  selected_checks?: ReturnType<typeof selectChecks>['selected']
}
const sha = /^[a-f0-9]{40}$/
const slug = /^[a-z][a-z0-9-]*$/
const evidenceOnly = /^docs\/published-evidence\/[a-z0-9][a-z0-9-]*[.]json$/
const permitted = new Set(Object.keys(lock.products))
const rawGit = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0' },
  timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']
})
const digest = (value: unknown) => sha256(JSON.stringify(value))

export function validateSourceSet(set: SourceSet) {
  assert(set && sha.test(set.workspace) && set.products && typeof set.products === 'object')
  assert.deepEqual(Object.keys(set.products).sort(), [...permitted].sort(), 'Unknown source repository set')
  assert(Object.values(set.products).every(value => sha.test(value)), 'Invalid full source SHA')
  return set
}

export function normalizedEvent(value: unknown, origin: 'local' | 'pull_request' | 'repository_dispatch' | 'workflow_dispatch' | 'schedule') {
  if (origin === 'local' || origin === 'schedule' || origin === 'workflow_dispatch') {
    assert(value === null || typeof value === 'object' && Object.keys(value).length === 0, 'Unexpected control payload')
    return { origin, privileged: false, repo: null, sha: null }
  }
  assert(value && typeof value === 'object' && !Array.isArray(value))
  const event = value as Record<string, unknown>
  assert.deepEqual(Object.keys(event).sort(), ['branch', 'repo', 'sha'], 'Unknown event fields')
  assert(typeof event.repo === 'string' && slug.test(event.repo) && permitted.has(event.repo), 'Unknown event repository')
  assert(typeof event.sha === 'string' && sha.test(event.sha), 'Invalid event commit')
  const workspace = resolveSources(lock).get('workspace')!
  const inventory = JSON.parse(rawGit(workspace.directory, 'show', workspace.sha + ':repositories.json'))
  const entry = inventory.repositories.find(row => row.id === event.repo)
  assert(entry && event.branch === entry.branch, 'Unexpected event target branch')
  return { origin, privileged: false, repo: event.repo, sha: event.sha }
}

export function checkReachable(event, candidate: SourceLock) {
  if (!event.repo) return
  assert(candidate.products[event.repo] === event.sha, 'Event does not match frozen source set')
  const repo = resolveSources(candidate).get(event.repo)!
  if (event.origin === 'repository_dispatch') {
    const workspace = resolveSources(lock).get('workspace')!
    const inventory = JSON.parse(rawGit(workspace.directory, 'show', workspace.sha + ':repositories.json'))
    const { branch } = inventory.repositories.find(entry => entry.id === event.repo)
    rawGit(repo.directory, 'merge-base', '--is-ancestor', event.sha, 'refs/remotes/origin/' + branch)
  }
}

export function discoverLocal(): SourceLock {
  const repos = resolveSources(lock)
  const heads = Object.fromEntries([...repos].map(([id, repo]) => [id, rawGit(repo.directory, 'rev-parse', 'HEAD').trim()]))
  const { workspace, ...products } = heads
  return { schema_version: 1, ...validateSourceSet({ workspace, products }) }
}

export function sourceChanges(before: SourceLock, after: SourceLock, workspace = workspaceRoot): Change[] {
  const base = resolveSources(before, workspace)
  const head = resolveSources(after, workspace)
  return [...head].flatMap(([repo_id, repo]) => {
    const former = base.get(repo_id)!
    if (former.sha === repo.sha) return []
    return rawGit(repo.directory, 'diff', '--name-only', '-z', former.sha, repo.sha, '--')
      .split('\0').filter(Boolean).map(path => ({ repo_id, path }))
  })
}

export function classify(changes: Change[], policy: 'pass' | 'violation' | 'unknown') {
  if (policy === 'violation') return 'POLICY_VIOLATION'
  if (policy === 'unknown') return 'UNKNOWN'
  const relevant = changes.filter(change => !evidenceOnly.test(change.path))
  if (!relevant.length) return 'NO_CHANGE'
  if (selectChecks(relevant).status === 'UNKNOWN') return 'UNKNOWN'
  const represented = relevant.every(({ repo_id, path }) =>
    /^docs\/.*[.]md$|^README[.]md$/.test(path) ||
    repo_id === 'stack' && ['compose.yaml', 'services/apisix/routes.template.json'].includes(path))
  return represented ? 'DOCUMENTATION_DRIFT' : 'UNKNOWN'
}

function inputFingerprint(candidate: SourceLock, workspace: string) {
  const trees = [...resolveSources(candidate, workspace)].map(([id, repo]) =>
    [id, rawGit(repo.directory, 'ls-tree', '-rz', repo.sha).split('\0').filter(row =>
      row && !evidenceOnly.test(row.slice(row.indexOf('\t') + 1)))])
  return digest(trees)
}

function checkPolicy(candidate: SourceLock, workspace: string) {
  const repos = resolveSources(candidate, workspace)
  const compose = extractComposeFacts(pinnedSource({ repo_id: 'stack', path: 'compose.yaml' }, repos))
  const gateway = extractGatewayFacts(pinnedSource({ repo_id: 'stack', path: 'services/apisix/routes.template.json' }, repos))
  return { compose, gateway }
}

function locked<T>(file: string, action: () => T) {
  mkdirSync(dirname(file), { recursive: true })
  const guard = file + '.lock'
  let fd
  for (let attempt = 0; ; attempt++) {
    try {
      fd = openSync(guard, 'wx', 0o600)
      break
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt === 50) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    return action()
  } finally {
    closeSync(fd)
    unlinkSync(guard)
  }
}

function readStatus(file: string): Status {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { generation: 0, run_id: '', comparison_status: 'NOT_VERIFIABLE',
      verified_source_set: null, verified_at: null, observed_source_set: null, observed_at: null,
      coverage: [], observed_coverage: [], comparison_source: 'local-heads', error: null, proposal_ref: null,
      evidence_sha256: null, relevant_input_sha256: null, observed_input_sha256: null, verified_model_sha256: null }
  }
}

function writeStatus(file: string, state: Status) {
  const temporary = file + '.' + randomUUID()
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, file)
}

export function beginStatus(file: string, observed: SourceSet, at = new Date().toISOString(),
  source: Status['comparison_source'] = 'local-heads') {
  validateSourceSet(observed)
  return locked(file, () => {
    const prior = readStatus(file)
    const state = { ...prior, generation: prior.generation + 1, run_id: randomUUID(),
      comparison_status: 'CHECKING', observed_source_set: observed, observed_at: at,
      comparison_source: source, observed_coverage: [], observed_input_sha256: null,
      error: null, proposal_ref: null, changes: [], findings: [], selected_checks: [] }
    writeStatus(file, state)
    return state
  })
}

export function finishStatus(file: string, started: Status, patch: Partial<Status>) {
  return locked(file, () => {
    const current = readStatus(file)
    if (current.generation !== started.generation || current.run_id !== started.run_id) return false
    const updated = { ...current, ...patch, generation: current.generation, run_id: current.run_id }
    writeStatus(file, updated)
    return true
  })
}

export function freshness(state: Status | null, now = Date.now()) {
  const observed = Date.parse(state?.observed_at ?? '')
  if (!state || !Number.isFinite(observed) || observed > now + 60000 || now - observed > 36 * 3600000)
    return 'Aktualität unbekannt'
  return state.comparison_status
}

export function checkedBundle(directory: string, expected: string, candidate: SourceLock) {
  const path = realpathSync(directory)
  const read = (name: string) => {
    const file = join(path, safePath(name))
    assert(realpathSync(file) === file, 'Evidence path escape')
    return readFileSync(file)
  }
  const manifest = read('runtime-evidence.json')
  assert(/^[a-f0-9]{64}$/.test(expected) && sha256(manifest) === expected, 'Unapproved runtime evidence digest')
  const actual = verifyRun(read)
  assert.deepEqual(JSON.parse(manifest.toString()), actual, 'Evidence no longer matches executed probes')
  assert.deepEqual(actual.sourceSet, candidate, 'Runtime evidence belongs to another source set')
  return actual.scenarios
}

async function createProposal(candidate: SourceLock, changes: Change[], facts, key: string,
  directory: string, agent: typeof callCodex) {
  mkdirSync(directory, { recursive: true })
  const destination = join(directory, key + '.json')
  const existing = () => {
    try {
      const saved = JSON.parse(readFileSync(destination, 'utf8'))
      assert.equal(saved.key, key)
      assert.deepEqual(saved.candidate, candidate)
      return true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return false
    }
  }
  if (existing()) return true
  let lease
  try {
    lease = openSync(destination + '.lock', 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  let temp
  try {
    if (existing()) return true
    const paths = ['docs/overview.md', 'docs/security.md', 'src/model/system.c4', 'src/model/deployment.c4',
      'src/views/architecture.c4', 'sources.lock.json']
    const inputs = paths.map(path => ({ path, contents: readFileSync(join(root, path), 'utf8') }))
    const anchors = [...new Set(['stack:compose.yaml', 'stack:services/apisix/routes.template.json',
      'workspace:repositories.json', ...changes.map(change => change.repo_id + ':' + change.path)])]
    const proposal = agent(inputs, {
      candidate, changes, runtimeServices: Object.fromEntries(Object.entries(facts.compose.services)
        .filter(([, service]) => service.classification === 'runtime')
        .map(([id, service]) => [id, { ports: service.ports, dependencies: service.startupDependencies }])),
      download: facts.gateway.download
    }, anchors)
    validateProposal({ changes: proposal.replacements }, inputs, new Set(anchors))
    assert(proposal.replacements.some(replacement => replacement.path === 'sources.lock.json'), 'Proposal must bind the candidate')
    temp = mkdtempSync(join(tmpdir(), 'di-checked-proposal-'))

    cpSync(join(root, 'src'), join(temp, 'src'), { recursive: true })
    for (const replacement of proposal.replacements) {
      if (replacement.path.startsWith('src/')) writeFileSync(join(temp, replacement.path), replacement.newText)
      if (replacement.path === 'sources.lock.json') assert.deepEqual(JSON.parse(replacement.newText), candidate)
    }
    execFileSync(join(root, 'node_modules/.bin/likec4'), ['validate', join(temp, 'src')], { stdio: 'pipe' })
    const model = await modelAt(join(temp, 'src'))
    const validated = await verifyArchitecture(facts, model)
    assert(validated.results.every(rule => rule.configuration === 'checked'), 'Candidate proposal violates the model contract')
    writeFileSync(destination, JSON.stringify({ key, candidate, proposal, review: 'PENDING_INDEPENDENT_REVIEW' }, null, 2),
      { mode: 0o600, flag: 'wx' })
    return true
  } finally {
    if (temp) rmSync(temp, { recursive: true })
    closeSync(lease)
    unlinkSync(destination + '.lock')
  }
}

export async function reconcile(candidate: SourceLock, event: ReturnType<typeof normalizedEvent>,
  file: string, observe = discoverLocal,
  options: { proposal?: boolean; evidence?: { directory: string; sha256: string }; source?: Status['comparison_source'];
    workspace?: string; proposalDirectory?: string; agent?: typeof callCodex } = {}) {
  validateSourceSet(candidate)
  checkReachable(event, candidate)
  const start = beginStatus(file, candidate, undefined, options.source)
  let result: Partial<Status>
  let classification = 'UNKNOWN'
  try {
    const workspace = options.workspace ?? workspaceRoot
    const changes = sourceChanges(lock, candidate, workspace)
    const selected = selectChecks(changes.filter(change => !evidenceOnly.test(change.path))).selected
    let policy: 'pass' | 'violation' | 'unknown' = 'pass'
    let facts
    let findings = []
    try {
      facts = checkPolicy(candidate, workspace)
      findings = policyFindings(facts)
      if (findings.length) policy = 'violation'
    } catch (error) {
      policy = 'unknown'
    }
    const decision = classify(changes, policy)
    classification = decision
    const newer = observe()
    if (digest(newer) !== digest(candidate)) {
      result = { comparison_status: 'SUPERSEDED', observed_source_set: newer, observed_at: new Date().toISOString() }
    } else if (decision === 'POLICY_VIOLATION' || decision === 'UNKNOWN') {
      result = { comparison_status: decision === 'UNKNOWN' ? 'NOT_VERIFIABLE' : 'VIOLATION', error: decision,
        findings, changes, selected_checks: selected }
    } else if (decision === 'NO_CHANGE') {
      const verified = await verifyArchitecture()
      assert(verified.results.every(rule => rule.configuration === 'checked'))
      const coverage = ['source-checked', 'configuration-checked']
      const fingerprint = inputFingerprint(candidate, workspace)
      assert.equal(fingerprint, inputFingerprint(lock, workspace), 'Relevant source inputs differ')
      if (options.evidence) {
        const dynamic = checkedBundle(options.evidence.directory, options.evidence.sha256, candidate)
        result = { comparison_status: 'VERIFIED', verified_source_set: candidate,
          verified_at: new Date().toISOString(), coverage: [...coverage, ...dynamic], observed_coverage: [...coverage, ...dynamic],
          evidence_sha256: options.evidence.sha256, relevant_input_sha256: fingerprint,
          verified_model_sha256: modelFingerprint() }
      } else if (start.verified_source_set && digest(start.verified_source_set) === digest(candidate) &&
        start.verified_model_sha256 === modelFingerprint() && start.evidence_sha256) {
        result = { comparison_status: 'VERIFIED', observed_coverage: start.coverage }
      } else if (changes.length && start.relevant_input_sha256 === fingerprint) {
        result = { comparison_status: 'EVIDENCE_ONLY', observed_coverage: coverage }
      } else {
        result = { comparison_status: 'NOT_VERIFIABLE', observed_coverage: coverage,
          error: 'Gebundene Laufzeitnachweise werden separat freigegeben.' }
      }
      result.observed_input_sha256 = fingerprint
    } else {
      const key = digest({ candidate, changes })
      const proposed = options.proposal && await createProposal(candidate, changes, facts, key,
        options.proposalDirectory ?? join(root, '.runtime/proposals'), options.agent ?? callCodex)
      result = { comparison_status: 'DRIFT', proposal_ref: proposed ? key : null,
        observed_coverage: ['configuration-checked'], changes, selected_checks: selected }
    }
    const latest = observe()
    if (digest(latest) !== digest(candidate)) {
      result = { comparison_status: 'SUPERSEDED', observed_source_set: latest, observed_at: new Date().toISOString() }
    }
  } catch (error) {
    result = { comparison_status: 'NOT_VERIFIABLE', error: error.name }
  }
  const written = finishStatus(file, start, result)
  return { ...(written ? result : { comparison_status: 'SUPERSEDED' }), run_id: start.run_id, written, decision: classification }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const candidate = args[0] === '--candidate' ? JSON.parse(readFileSync(args.splice(0, 2)[1], 'utf8')) : discoverLocal()
  const proposal = args[0] === '--proposal' && args.shift() !== undefined
  const evidence = args[0] === '--evidence' ? { directory: args.splice(0, 2)[1], sha256: args.shift()! } : undefined
  assert(args.length === 0, 'Unexpected reconcile arguments')
  const outcome = await reconcile(candidate, normalizedEvent(null, 'local'), join(root, '.runtime/status.json'),
    discoverLocal, { proposal, evidence })
  console.log(JSON.stringify(outcome, null, 2))
  if (['VIOLATION', 'SUPERSEDED'].includes(outcome.comparison_status)) process.exitCode = 1
}
