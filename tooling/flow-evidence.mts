import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateEvidence, type Evidence, type EvidenceContract } from './evidence.mts'
import { lock, pinnedSource, resolveSources, root as architectureRoot, safePath, sha256, workspaceRoot } from './sources.mts'

const scripts = {
  dynamic: ['scripts/test_architecture_flows.py', 'scripts/test_csv_delivery.py',
    'scripts/test_delivery_processing.py', 'scripts/delivery_processing_harness.py', 'scripts/delivery_queue_harness.py'],
  rights: ['scripts/test_public_catalog.py']
}
const expected = {
  dynamic: ['python3', scripts.dynamic[0]],
  rights: ['python3', scripts.rights[0], '--rights-only']
}
const files = {
  dynamic: ['dynamic-flow.log', 'dynamic-process.json', 6],
  rights: ['rights-flow.log', 'rights-process.json', 4]
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

type RunMetadata = { argv: string[]; exit: number; startedAt: string; finishedAt: string; toolVersion: string }
type ReadLog = (path: string) => Buffer
type Group = keyof typeof files

function line(lines: string[], prefix: string) {
  const matches = lines.filter(line => line.startsWith(prefix + ' '))
  assert.equal(matches.length, 1, 'Missing or repeated flow checkpoint: ' + prefix)
  return matches[0]
}

export function boundObservations(dynamic: string, rights: string) {
  const items = dynamic.split(/\r?\n/)
  const accept = line(items, 'FLOW ingestion.accepted')
  const project = line(items, 'FLOW ingestion.projected')
  const acceptedId = accept.split(' ')[2].split('=')[1]
  assert(uuid.test(acceptedId) && project.includes('submission=' + acceptedId + ' '))
  assert(items.indexOf(accept) < items.indexOf(project) && accept.includes('postgres=COMMITTED clickhouse=absent bound_checkpoints=5'))
  assert(project.includes('postgres=PUBLISHED verified_exports=csv,xlsx,parquet idempotent=true'))
  assert(line(items, 'FLOW ingestion.denied').includes('missing_artifact=true revoked_before_commit=true valid_version_preserved=true'))
  assert(line(items, 'FLOW download.bytes').includes('open=200 granted=200 revoked=403 outage=503 denied_origin=0'))
  assert(line(items, 'FLOW cleanup').includes('owned_containers=0 owned_volumes=0'))
  const toolchain = line(items, 'FLOW toolchain')
  assert(/^FLOW toolchain jenkins_image=sha256:[0-9a-f]{64} provenance_sha256=[0-9a-f]{64}$/.test(toolchain))
  const rightsLines = rights.split(/\r?\n/)
  assert(rightsLines.includes('FLOW rights dataset_request,decision,grant,revoke,audit and separate submit/manage rights'))
  assert(rightsLines.includes('FLOW rights di_public views allowed; base, grants, audit and writes rejected'))
  return { acceptedId, toolchain, scenarios: ['DYN-DOWNLOAD', 'DYN-RIGHTS', 'DYN-INGESTION'] }
}

function contract(group: Group, run: RunMetadata, toolchain: string): EvidenceContract {
  assert.deepEqual(run.argv, expected[group], 'Unexpected runtime command')
  assert(typeof run.toolVersion === 'string' && run.toolVersion.length > 0)
  const sources = { workspace: lock.workspace, ...lock.products }
  const paths = [...scripts[group], 'scripts/compose_runtime.py', 'scripts/ingestion_test_runtime.py', 'compose.yaml']
  const testSha256 = sha256(JSON.stringify(paths.map(path =>
    [path, sha256(pinnedSource({ repo_id: 'stack', path }))])))
  return { check: group === 'dynamic' ? 'DYN-DOWNLOAD+DYN-INGESTION' : 'DYN-RIGHTS',
    inputSha256: sha256(JSON.stringify(sources)), testSha256,
    toolSha256: sha256(run.toolVersion + '\n' + (group === 'dynamic' ? toolchain : 'postgresql-rights')),
    sources, argv: expected[group], minimumAssertions: files[group][2] as number }
}

export function verifyRun(readLog: ReadLog) {
  const observed = boundObservations(readLog('dynamic-flow.log').toString(), readLog('rights-flow.log').toString())
  const results = []
  for (const group of ['dynamic', 'rights'] as Group[]) {
    const [log, metadata, assertions] = files[group] as [string, string, number]
    const run: RunMetadata = JSON.parse(readLog(metadata).toString())
    const expected = contract(group, run, observed.toolchain)
    const raw = readLog(log)
    const report: Evidence = {
      schema_version: 1, contract: expected, result: run.exit === 0 ? 'PASS' : 'FAIL',
      process: { exit: run.exit, assertions, skipped: 0, startedAt: run.startedAt, finishedAt: run.finishedAt },
      output: { path: log, sha256: sha256(raw), bytes: raw.length }
    }
    evaluateEvidence(report, expected, readLog)
    assert.throws(() => evaluateEvidence({ ...report, process: { ...report.process, assertions: 0 } }, expected, readLog))
    assert.throws(() => evaluateEvidence({ ...report, process: { ...report.process, skipped: 1 } }, expected, readLog))
    assert.throws(() => evaluateEvidence({ ...report, contract: { ...expected, inputSha256: '0'.repeat(64) } }, expected, readLog))
    results.push(report)
  }
  const rules = JSON.parse(readFileSync(join(architectureRoot, 'contracts/invariants.json'), 'utf8')).rules
  const coveredClaims = Object.fromEntries(observed.scenarios.map(id =>
    [id, [...new Set(rules.filter(rule => rule.runtime === id).map(rule => rule.claim_id))].sort()]))
  return { sourceSet: lock, scenarios: observed.scenarios, coveredClaims, submission: observed.acceptedId, results }
}

function main(directory: string) {
  const root = realpathSync(directory)
  for (const [id, repo] of resolveSources(lock, workspaceRoot)) {
    assert.equal(execFileSync('git', ['-C', repo.directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      repo.sha, 'Runtime evidence source HEAD differs: ' + id)
  }
  const result = verifyRun(path => readFileSync(join(root, safePath(path))))
  writeFileSync(join(root, 'runtime-evidence.json'), JSON.stringify(result, null, 2) + '\n')
  console.log('Bound download, rights and ingestion runtime evidence; zero/skipped/stale probes refused')
  console.log('ASSERTIONS=8 SKIP=0')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2])
