import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { validateProposal } from '../tooling/codex-patch.mts'
import { beginStatus, classify, discoverLocal, finishStatus, freshness, normalizedEvent,
  reconcile, sourceChanges } from '../tooling/reconcile.mts'
import { lock, resolveSources, root, sha256, workspaceRoot } from '../tooling/sources.mts'
import { statusPresentation } from '../tooling/status-view.mjs'

test('local reconciliation freezes the same source set and records a no-op', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'di-reconcile-test-'))
  try {
    const before = discoverLocal()
    assert.deepEqual(before, lock)
    assert.deepEqual(sourceChanges(before, lock), [])
    const file = join(temp, 'status.json')
    const output = await reconcile(before, normalizedEvent(null, 'local'), file)
    assert.equal(output.decision, 'NO_CHANGE')
    assert.equal(output.comparison_status, 'NOT_VERIFIABLE')
    assert.deepEqual(discoverLocal(), before)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).verified_source_set, null)
  } finally {
    await rm(temp, { recursive: true })
  }
})

test('only legitimate drift permits a bounded proposal', () => {
  const docs = [{ repo_id: 'architecture', path: 'docs/overview.md' }]
  assert.equal(classify(docs, 'pass'), 'DOCUMENTATION_DRIFT')
  assert.equal(classify(docs, 'violation'), 'POLICY_VIOLATION')
  assert.equal(classify(docs, 'unknown'), 'UNKNOWN')
  assert.equal(classify([{ repo_id: 'architecture', path: 'docs/published-evidence/sample.json' }], 'pass'), 'NO_CHANGE')
  const inputs = [{ path: 'docs/overview.md', contents: 'before' }, { path: 'contracts/invariants.json', contents: '{}' }]
  const allowed = new Set(['stack:compose.yaml'])
  const safe = { path: 'docs/overview.md', beforeSha256: sha256('before'), newText: 'after', sources: [...allowed] }
  assert.equal(validateProposal({ changes: [safe] }, inputs, allowed).length, 1)
  for (const mutation of [
    { ...safe, path: '../docs/overview.md' },
    { ...safe, path: 'contracts/invariants.json', beforeSha256: sha256('{}') },
    { ...safe, sources: ['injected'] },
    { ...safe, beforeSha256: 'f'.repeat(64) }
  ]) assert.throws(() => validateProposal({ changes: [mutation] }, inputs, allowed))
})

test('frozen Git drift proposes once and a policy violation never calls the agent', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'di-drift-test-'))
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  try {
    git(temp, 'clone', '-q', '--no-hardlinks', workspaceRoot, '.')
    git(temp, 'checkout', '-q', '--detach', lock.workspace)
    const { repositories } = JSON.parse(git(temp, 'show', 'HEAD:repositories.json'))
    const original = resolveSources(lock)
    for (const row of repositories.filter(row => Object.hasOwn(lock.products, row.id))) {
      git(temp, 'clone', '-q', '--no-hardlinks', original.get(row.id).directory, row.path)
      git(join(temp, row.path), 'checkout', '-q', '--detach', lock.products[row.id])
    }
    const stack = join(temp, repositories.find(row => row.id === 'stack').path)
    const compose = join(stack, 'compose.yaml')
    const text = await readFile(compose, 'utf8')
    const commit = (...paths) => {
      git(stack, 'add', '--', ...paths)
      git(stack, '-c', 'user.name=Architecture Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-qm', 'Synthetic candidate')
      return { ...lock, products: { ...lock.products, stack: git(stack, 'rev-parse', 'HEAD') } }
    }
    const currentStatus = join(temp, 'evidence.json')
    await reconcile(lock, normalizedEvent(null, 'local'), currentStatus, () => lock, { workspace: temp })
    const originalState = JSON.parse(await readFile(currentStatus, 'utf8'))
    const verified = beginStatus(currentStatus, lock)
    assert(finishStatus(currentStatus, verified, { comparison_status: 'VERIFIED', verified_source_set: lock,
      relevant_input_sha256: originalState.observed_input_sha256, coverage: ['DYN-DOWNLOAD'] }))
    await mkdir(join(stack, 'docs/published-evidence'), { recursive: true })
    await writeFile(join(stack, 'docs/published-evidence/fixture.json'), '{}\n')
    const reportOnly = commit('docs/published-evidence/fixture.json')
    const evidence = await reconcile(reportOnly, normalizedEvent(null, 'local'), currentStatus,
      () => reportOnly, { workspace: temp })
    assert.equal(evidence.comparison_status, 'EVIDENCE_ONLY')
    assert.equal(evidence.observed_input_sha256, originalState.observed_input_sha256)
    assert.deepEqual(JSON.parse(await readFile(currentStatus, 'utf8')).verified_source_set, lock)

    assert(text.includes('127.0.0.1:'))
    const port = text.replace('127.0.0.1:', '[::1]:')
    await writeFile(compose, port)
    const drift = commit('compose.yaml')
    const proposalDirectory = join(temp, 'proposals')
    let calls = 0
    const agent = (files, facts) => {
      calls++
      assert.deepEqual(facts.candidate, drift)
      assert(Object.values(facts.runtimeServices).some(service => service.ports.some(port => port.host === '[::1]')))
      const replacements = [
        { path: 'docs/overview.md', newText: files.find(file => file.path === 'docs/overview.md').contents +
          '\nIm Prüfbeispiel lauscht der Dienst auf der IPv6-Loopbackadresse.\n' },
        { path: 'sources.lock.json', newText: JSON.stringify(drift) }
      ].map(change => ({ ...change, beforeSha256: sha256(files.find(file => file.path === change.path).contents),
        sources: ['stack:compose.yaml'] }))
      return { replacements, changes: [], patch: 'fixture-patch', tool: 'stubbed transport' }
    }
    const execute = candidate => reconcile(candidate, normalizedEvent(null, 'local'), join(temp, 'status.json'),
      () => candidate, { workspace: temp, proposal: true, proposalDirectory, agent })
    const proposed = await execute(drift)
    assert.equal(proposed.comparison_status, 'DRIFT')
    assert.equal(typeof proposed.proposal_ref, 'string')
    const saved = JSON.parse(await readFile(join(proposalDirectory, proposed.proposal_ref + '.json'), 'utf8'))
    assert.deepEqual(saved.candidate, drift)
    assert.equal(saved.review, 'PENDING_INDEPENDENT_REVIEW')
    assert.equal((await execute(drift)).proposal_ref, proposed.proposal_ref)
    assert.equal(calls, 1)

    await writeFile(compose, text.replace('127.0.0.1:', '0.0.0.0:'))
    const violation = await execute(commit('compose.yaml'))
    assert.equal(violation.comparison_status, 'VIOLATION')
    assert(violation.findings.some(finding => finding.check === 'ARCH-TOPOLOGY' &&
      finding.sources.includes('stack:compose.yaml')))
    await writeFile(join(stack, 'unmapped-architecture-fixture.txt'), 'fixture\n')
    await writeFile(compose, port)
    const unknown = await execute(commit('compose.yaml', 'unmapped-architecture-fixture.txt'))
    assert.equal(unknown.comparison_status, 'NOT_VERIFIABLE')
    assert.equal(unknown.decision, 'UNKNOWN')
    assert.equal(calls, 1)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('stale, failed and superseded observations retain the last exact verified source', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'di-status-test-'))
  try {
    const file = join(temp, 'status.json')
    const first = beginStatus(file, lock, '2026-11-06T12:00:00Z')
    const coverage = ['DYN-DOWNLOAD','DYN-RIGHTS','DYN-INGESTION']
    const modelSha = '1'.repeat(64)
    assert(finishStatus(file, first, { comparison_status: 'VERIFIED', verified_source_set: lock,
      verified_at: '2026-11-06T12:00:01Z', coverage, verified_model_sha256: modelSha, evidence_sha256: '2'.repeat(64) }))
    const changed = { ...lock, products: { ...lock.products, admin: 'f'.repeat(40) } }
    const older = beginStatus(file, changed, '2026-11-06T13:00:00Z')
    const newer = beginStatus(file, changed, '2026-11-06T14:00:00Z')
    assert(!finishStatus(file, older, { comparison_status: 'VERIFIED' }))
    assert(finishStatus(file, newer, { comparison_status: 'VIOLATION', error: 'fixture' }))
    const state = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(state.verified_source_set, lock)
    assert.deepEqual(state.observed_source_set, changed)
    assert.equal(statusPresentation(state, lock, modelSha, Date.parse('2026-11-06T14:30:00Z')).runtime, true)
    assert.equal(statusPresentation(state, lock, '3'.repeat(64), Date.parse('2026-11-06T14:30:00Z')).runtime, false)
    assert.match(statusPresentation(state, lock, modelSha, Date.parse('2026-11-06T14:30:00Z')).label, /verletzt/)
    assert.equal(freshness(state, Date.parse('2026-11-09T14:00:00Z')), 'Aktualität unbekannt')
    assert.equal(statusPresentation(null, lock).label, 'Aktualität unbekannt')
    assert.equal(statusPresentation({ ...state, comparison_status: 'VERIFIED' }, lock,
      modelSha, Date.parse('2026-11-06T14:30:00Z')).label, 'Aktualität unbekannt')
  } finally {
    await rm(temp, { recursive: true })
  }
})

test('workflow and event boundaries reject untrusted permissions and inputs', async () => {
  const valid = { repo: 'stack', branch: 'main', sha: lock.products.stack }
  assert.equal(normalizedEvent(valid, 'repository_dispatch').privileged, false)
  assert.equal(normalizedEvent(valid, 'pull_request').privileged, false)
  for (const invalid of [
    { ...valid, repo: '../../stack' }, { ...valid, sha: '$(id)' },
    { ...valid, branch: 'refs/heads/main' }, { ...valid, privileged: true }, { ...valid, token: 'secret' }
  ]) assert.throws(() => normalizedEvent(invalid, 'repository_dispatch'))
  const workflow = parse(await readFile(join(root, '.github/workflows/architecture.yml'), 'utf8'))
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request','repository_dispatch','schedule','workflow_dispatch'])
  for (const step of workflow.jobs.verify.steps) {
    if (step.uses) assert(/@[a-f0-9]{40}$/.test(step.uses))
    if (step.run) assert(!step.run.includes('${{'))
  }
  assert.equal(workflow.jobs.verify.steps[0].with['persist-credentials'], false)
  assert.match(workflow.jobs.verify.steps[0].with.ref, /pull_request[.]base[.]sha/)
})
