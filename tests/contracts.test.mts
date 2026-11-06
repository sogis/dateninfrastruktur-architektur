import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractComposeFacts, extractGatewayFacts, sourceFacts } from '../tooling/facts.mts'
import { evaluateEvidence } from '../tooling/evidence.mts'
import { modelAt } from '../tooling/model.mts'
import { lock, pinnedSource, resolveSources, selectSource, sha256 } from '../tooling/sources.mts'
import { selectChecks } from '../tooling/select-checks.mts'
import { assertDownloadConfig, compareTopology, validateBindings, verifyArchitecture } from '../tooling/validate-model.mts'

test('facts use exact Git sources, explicit profiles and synthetic values', () => {
  assert.equal(resolveSources(lock).size, 7)
  assert.throws(() => resolveSources({ ...lock, products: { ...lock.products, admin: 'f'.repeat(40) } }))
  assert.throws(() => pinnedSource({ repo_id: 'stack', path: '../secret' }), /Unsafe/)
  const source = sourceFacts()
  assert.equal(source.compose.services['management-setup'].classification, 'setup')
  assert.equal(source.compose.services['test-fixture'].classification, 'test')
  assert.equal(source.compose.services.gateway.ports[0].host, '127.0.0.1')
  assert.equal(source.compose.services.gateway.ports[0].published, 18081)
  assert(source.compose.services.gateway.startupDependencies.includes('origin'))
  assert(!JSON.stringify(source).includes('POSTGRES_ADMIN_PASSWORD='))
  assert.equal(source.gateway.download.auth?.allowDegradation, false)
})

test('bindings are unique and contain exact anchors and source hashes', () => {
  const anchors = validateBindings()
  assert(anchors.size >= 10)
  assert(anchors.get('download.authorization-before-origin').every(anchor => /^[a-f0-9]{64}$/.test(anchor.sha256)))
  assert.throws(() => selectSource('class Exact {}', { kind: 'symbol', name: 'Missing' }), /missing/)
  assert.throws(() => selectSource('class Exact {} class Exact {}', { kind: 'symbol', name: 'Exact' }), /Ambiguous/)
  assert.throws(() => selectSource('{"routes":[{"id":"x"},{"id":"x"}]}',
    { kind: 'json-object', collection: 'routes', id: 'x' }), /Ambiguous/)
})

test('all initial invariants read current facts and report outstanding runtime evidence', async () => {
  const report = await verifyArchitecture()
  assert.equal(report.results.length, 15)
  assert(report.results.every(result => result.configuration === 'checked'), JSON.stringify(report.results))
  assert(report.results.some(result => result.runtime === 'unverified'))
  assert(report.results.every(result => result.runtime !== 'verified'))
})

test('mutations of services, auth and upstream are rejected', async () => {
  const model = await modelAt()
  const compose = JSON.parse(pinnedSource({ repo_id: 'stack', path: 'compose.yaml' }))
  compose.services.unbound = { image: 'synthetic-only' }
  assert.throws(() => compareTopology(model, extractComposeFacts(JSON.stringify(compose))), /Runtime service set differs/)
  const data = JSON.parse(pinnedSource({ repo_id: 'stack', path: 'services/apisix/routes.template.json' }))
  const routes = () => extractGatewayFacts(JSON.stringify(data))
  const download = data.routes.find(route => route.id === 'download')
  const auth = download.plugins['forward-auth']
  delete download.plugins['forward-auth']
  assert.throws(() => assertDownloadConfig(routes()), /forward-auth absent/)
  download.plugins['forward-auth'] = auth
  download.upstream.nodes = { 'garage:3900': 1 }
  assert.throws(() => assertDownloadConfig(routes()), /Unexpected download upstream/)
})

test('manipulated, skipped and old-source evidence cannot become PASS', () => {
  const stdout = Buffer.from('fixture proof\nASSERTIONS=2 SKIP=0\n')
  const binding = { check: 'DYN-DOWNLOAD', inputSha256: 'b'.repeat(64),
    testSha256: 'c'.repeat(64), toolSha256: 'd'.repeat(64), sources: { stack: lock.products.stack },
    argv: ['fixture'], minimumAssertions: 2 }
  const report = { schema_version: 1, contract: binding, result: 'PASS', process: {
    exit: 0, assertions: 2, skipped: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z'
  }, output: { path: 'test.log', sha256: sha256(stdout), bytes: stdout.length } }
  assert(evaluateEvidence(report, binding, () => stdout))
  for (const edited of [
    { ...report, contract: { ...binding, sources: { stack: 'a'.repeat(40) } } },
    { ...report, process: { ...report.process, assertions: 0 } },
    { ...report, process: { ...report.process, skipped: 1 } },
    { ...report, output: { ...report.output, sha256: 'a'.repeat(64) } }
  ]) assert.throws(() => evaluateEvidence(edited, binding, () => stdout))
})

test('selection follows direct and transitive inputs and labels unknown changes', () => {
  const ids = result => result.selected.map(row => row.id)
  const direct = selectChecks([{ repo_id: 'stack', path: 'services/apisix/routes.template.json' }])
  assert(ids(direct).includes('ARCH-DOWNLOAD-CONFIG') && ids(direct).includes('DYN-DOWNLOAD'))
  const schema = selectChecks([{ repo_id: 'admin', path: 'db/schema/physical_contract.sql' }])
  assert(['DYN-DOWNLOAD','DYN-RIGHTS','DYN-INGESTION','SCHEMA-BASELINE',
    'ARCH-MODEL-PERSISTENCE','ARCH-SCHEMA-VERIFY'].every(id => ids(schema).includes(id)))
  const identity = selectChecks([{ repo_id: 'admin', path: 'db/schema/principal_identity.sql' }])
  assert(ids(identity).includes('ARCH-IDENTITY-GUARD'))
  const compose = selectChecks([{ repo_id: 'stack', path: 'compose.yaml' }])
  assert(ids(compose).includes('ARCH-TOPOLOGY') && ids(compose).includes('ARCH-PG-BOUNDARY'))
  assert(!ids(compose).includes('ARCH-COMPOSE'))
  assert.deepEqual(ids(selectChecks([{ repo_id: 'architecture', path: 'docs/security.md' }])), ['ARCH-DOCS'])
  const unknown = selectChecks([{ repo_id: 'stack', path: 'unknown_binary' }])
  assert.equal(unknown.status, 'UNKNOWN')
  assert.deepEqual(ids(unknown), ['ARCH-MANUAL-REVIEW'])
})
