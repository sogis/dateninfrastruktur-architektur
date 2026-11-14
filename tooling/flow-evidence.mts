import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateEvidence, type Evidence, type EvidenceContract } from './evidence.mts'
import { lock, pinnedSource, resolveSources, root as architectureRoot, safePath, sha256, workspaceRoot } from './sources.mts'

const checks = [
  {
    script: 'test_delivery_domain',
    file: 'delivery-domain',
    scenarios: ['DYN-INGESTION'],
    minimumAssertions: 62,
    markers: ['DELIVERY_HTTP_ASSERTIONS=15 SKIP=0', 'DELIVERY_DOMAIN_ASSERTIONS=38 SKIP=0',
      'ACCESS_CATALOG_CASES=5 SKIP=0'],
  },
  {
    script: 'test_public_catalog',
    file: 'public-catalog',
    scenarios: ['DYN-DOWNLOAD', 'DYN-RIGHTS'],
    minimumAssertions: 47,
    markers: ['PUBLIC_VIEWS_ASSERTIONS=21 SKIP=0', 'PUBLIC_GATEWAY_CASES=26 SKIP=0'],
  },
]

type RunMetadata = { argv: string[]; exit: number; startedAt: string; finishedAt: string; toolVersion: string }
type ReadLog = (path: string) => Buffer

export function verifyRun(readLog: ReadLog) {
  const sources = { workspace: lock.workspace, ...lock.products }
  const results = checks.map(check => {
    const log = check.file + '.log'
    const raw = readLog(log)
    const lines = raw.toString().split(/\r?\n/)
    const counts = lines.filter(line => /^ASSERTIONS=[1-9][0-9]* SKIP=0$/.test(line))
    assert.equal(counts.length, 1, 'Missing or repeated assertion marker for ' + check.file)
    assert(check.markers.every(marker => lines.filter(line => line === marker).length === 1))
    const assertions = Number(counts[0].split(/[= ]/)[1])
    const script = 'scripts/' + check.script + '.py'
    const argv = ['python3', script]
    const run: RunMetadata = JSON.parse(readLog(check.file + '-process.json').toString())
    assert.deepEqual(run.argv, argv, 'Unexpected runtime command')
    assert(typeof run.toolVersion === 'string' && run.toolVersion.length > 0)
    const paths = [script, 'scripts/compose_runtime.py', 'scripts/ingestion_test_runtime.py',
      'scripts/test_management_bootstrap.py', 'compose.yaml']
    if (check.file === 'public-catalog') {
      paths.push('services/apisix/routes.template.json', 'services/apisix/config.single.yaml',
        'services/apisix/dns-cache.lua')
    }
    const contract: EvidenceContract = {
      check: check.scenarios.join('+'), inputSha256: sha256(JSON.stringify(sources)),
      testSha256: sha256(JSON.stringify(paths.map(path => [path, sha256(pinnedSource({ repo_id: 'stack', path }))]))),
      toolSha256: sha256(run.toolVersion), sources, argv, minimumAssertions: check.minimumAssertions,
    }
    const report: Evidence = {
      schema_version: 1, contract, result: run.exit === 0 ? 'PASS' : 'FAIL',
      process: { exit: run.exit, assertions, skipped: 0, startedAt: run.startedAt, finishedAt: run.finishedAt },
      output: { path: log, sha256: sha256(raw), bytes: raw.length },
    }
    evaluateEvidence(report, contract, readLog)
    return report
  })
  const scenarios = checks.flatMap(check => check.scenarios).sort()
  const rules = JSON.parse(readFileSync(join(architectureRoot, 'contracts/invariants.json'), 'utf8')).rules
  const coveredClaims = Object.fromEntries(scenarios.map(id =>
    [id, [...new Set(rules.filter(rule => rule.runtime === id).map(rule => rule.claim_id))].sort()]))
  return { sourceSet: lock, scenarios, coveredClaims, results }
}

function main(directory: string) {
  const root = realpathSync(directory)
  for (const [id, repo] of resolveSources(lock, workspaceRoot)) {
    assert.equal(execFileSync('git', ['-C', repo.directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      repo.sha, 'Runtime evidence source HEAD differs: ' + id)
  }
  const result = verifyRun(path => readFileSync(join(root, safePath(path))))
  writeFileSync(join(root, 'runtime-evidence.json'), JSON.stringify(result, null, 2) + '\n')
  console.log('Bound the current delivery and public-catalog runtime observations')
  console.log('ASSERTIONS=6 SKIP=0')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2])
