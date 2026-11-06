import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sourceFacts } from './facts.mts'
import { checkArchitecture, checkFlowSemantics, modelAt, requiredViews } from './model.mts'
import { pinnedSource, resolveBinding, root } from './sources.mts'

const json = name => JSON.parse(readFileSync(join(root, 'contracts', name + '.json'), 'utf8'))
export const bindings = json('source-bindings').claims
export const rules = json('invariants').rules
const claim = id => bindings.find(entry => entry.claim_id === id)

export function validateBindings() {
  const claims = new Set()
  const ruleIds = new Set(rules.map(rule => rule.id))
  const result = new Map()
  for (const binding of bindings) {
    assert(!claims.has(binding.claim_id), 'Duplicate architecture claim')
    claims.add(binding.claim_id)
    assert.equal(binding.scope, 'local-compose')
    assert(binding.sources.length && binding.view_ids.length &&
      binding.view_ids.every(id => requiredViews.includes(id)), 'Unbound source or view')
    assert(binding.check_ids.length && binding.check_ids.every(id => ruleIds.has(id)), 'Claim selects an unregistered rule')
    const anchors = binding.sources.map(resolveBinding)
    const selectors = anchors.map(row => JSON.stringify([row.repo_id, row.path, row.selector]))
    assert.equal(selectors.length, new Set(selectors).size, 'Duplicate source binding')
    result.set(binding.claim_id, anchors.map(({ value, ...anchor }) => anchor))
  }
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length)
  for (const rule of rules) {
    assert(rule.id.startsWith('ARCH-') && claim(rule.claim_id)?.check_ids.includes(rule.id), 'Rule lacks a claim association')
    assert.equal(rule.scope, 'local-compose')
  }
  return result
}

export function compareTopology(model, facts) {
  const declared = [...model.children('di')].map(node => node.id.slice(3)).sort()
  const runtime = Object.entries(facts.services).filter(([, service]) =>
    service.classification === 'runtime').map(([id]) => id).sort()
  assert.deepEqual(declared, runtime, 'Runtime service set differs from the model')
  assert(Object.values(facts.services).flatMap(service => service.ports).every(port =>
    port.host === '127.0.0.1' || port.host === '[::1]'), 'Published service port is not loopback')
}

export function assertDownloadConfig(routes) {
  const download = routes.download
  assert(download?.auth, 'Download forward-auth absent')
  assert.equal(download.auth.uri, 'http://admin:8080/internal/authorization/check')
  assert.equal(download.auth.allowDegradation, false)
  assert.equal(download.auth.errorStatus, 503)
  assert.deepEqual(download.upstreams, ['origin:8080'], 'Unexpected download upstream')
  assert.deepEqual(download.matches, ['/downloads', '/downloads/*'])
}

function postgres(facts) {
  const databases = facts.databases
  assert.deepEqual([...new Set(databases.map(db => db.server))], ['postgres'])
  assert.deepEqual([...new Set(databases.map(db => db.database))].sort(),
    ['dateninfrastruktur_management', 'keycloak', 'superset'])
  assert.deepEqual(databases.map(db => db.role).sort(),
    ['di_audit_reader', 'di_authz', 'di_public', 'di_writer', 'keycloak', 'superset'])
  assert.equal(facts.services.postgres.ports.length, 0)
}

function publicCatalog(facts) {
  assert(facts.compose.databases.some(db => db.role === 'di_public' &&
    db.database === 'dateninfrastruktur_management'))
  assert.deepEqual(facts.gateway['public-catalog'].upstreams, ['sodata:8080'])
}

function storage(facts) {
  const origin = facts.compose.services.origin
  assert.equal(facts.compose.storageBucket, 'ch.so.daten')
  assert(origin.command.includes('--read-only') && origin.command.includes('storage:ch.so.daten/downloads'))
  assert(origin.mounts.some(mount => typeof mount === 'string' && mount.endsWith('origin.conf:/config/rclone/rclone.conf:ro')))
  const keys = facts.compose.services['garage-setup'].envNames
  assert(['DI_STORAGE_READER_ACCESS_KEY', 'DI_STORAGE_WRITER_ACCESS_KEY'].every(name => keys.includes(name)))
  assert.equal(facts.compose.services.garage.ports.length, 0)
  assert.equal(origin.ports.length, 0)
}

export function policyFindings(facts) {
  const checks = [
    ['ARCH-DOWNLOAD-CONFIG', 'stack:services/apisix/routes.template.json', () => assertDownloadConfig(facts.gateway)],
    ['ARCH-PG-BOUNDARY', 'stack:compose.yaml', () => postgres(facts.compose)],
    ['ARCH-PUBLIC-CATALOG', 'stack:compose.yaml, stack:services/apisix/routes.template.json', () => publicCatalog(facts)],
    ['ARCH-STORAGE', 'stack:compose.yaml', () => storage(facts)],
    ['ARCH-TOPOLOGY', 'stack:compose.yaml', () => assert(Object.values(facts.compose.services)
      .flatMap(service => service.ports).every(port => port.host === '127.0.0.1' || port.host === '[::1]'))]
  ] as const
  return checks.flatMap(([check, sources, run]) => {
    try {
      run()
      return []
    } catch (error) {
      if (error.code !== 'ERR_ASSERTION') throw error
      return [{ check, sources: sources.split(', ') }]
    }
  })
}

function schema() {
  const manifest = JSON.parse(pinnedSource({ repo_id: 'admin', path: 'db/schema/manifest.json' }))
  assert(/^management-\d{8}$/.test(manifest.baseline))
  assert(manifest.models.length && manifest.models.every(path => path.endsWith('.ili')))
  assert(manifest.steps.includes('db/schema/physical_contract.sql'))
  assert('datamap.sha256' in manifest.artifacts && 'toolchain.sha256' in manifest.artifacts)
  assert(!manifest.steps.some(step => /upgrade|migration/i.test(step)))
}

const java = (path: string) => pinnedSource({
  repo_id: 'admin', path: 'src/main/java/ch/so/agi/dateninfrastruktur/admin/' + path + '.java'
})

function submissionAuth(model) {
  checkFlowSemantics(model)
  const source = java('ingestion/SubmissionAuthorizationService')
  assert(source.includes('authority.allowed(context,actor,dataset,"submit_data")'))
  assert(source.includes('authority.allowed(context,actor,dataset,"manage_submitters")'))
}

function evidenceBinding(model) {
  checkFlowSemantics(model)
  const source = java('ingestion/ResultEvidenceValidator')
  assert(source.includes('digest.equals(result.planDigest())'))
  assert(source.includes('input(plan,result.input())') && source.includes('result.snapshot()') && source.includes('result.outputs()'))
}

function publication(model) {
  checkFlowSemantics(model)
  assert(java('ingestion/PublicationService').includes("SET status='COMMITTED'"))
  const reconcile = java('ingestion/PublicationReconciler')
  const project = reconcile.indexOf('projector.project(view,')
  assert(project >= 0 && reconcile.indexOf('finish(job,wanted)', project) > project)
}

function currentIdentity() {
  schema()
  const identity = pinnedSource({ repo_id: 'admin', path: 'db/schema/principal_identity.sql' })
  assert(identity.includes('principal external identity immutable'))
  assert(!identity.includes('operator.migrate_identity') && !identity.includes('di_migrator'))
}

const configuration = {
  'ARCH-TOPOLOGY': (model, facts) => compareTopology(model, facts.compose),
  'ARCH-PG-BOUNDARY': (_, facts) => postgres(facts.compose),
  'ARCH-DOWNLOAD-CONFIG': (_, facts) => assertDownloadConfig(facts.gateway),
  'ARCH-DOWNLOAD-RUNTIME': (_, facts) => assertDownloadConfig(facts.gateway),
  'ARCH-PUBLIC-CATALOG': (_, facts) => publicCatalog(facts),
  'ARCH-STORAGE': (_, facts) => storage(facts),
  'ARCH-SUBMISSION-AUTH': model => submissionAuth(model),
  'ARCH-INGESTION-EVIDENCE': model => evidenceBinding(model),
  'ARCH-PUBLICATION': model => publication(model),
  'ARCH-RIGHTS-SCOPE': model => checkFlowSemantics(model),
  'ARCH-MODEL-PERSISTENCE': () => schema(),
  'ARCH-TRUTHFUL-SCOPE': (_, facts) => {
    assert(facts.compose.services.superset.classification === 'runtime')
    assert(facts.compose.databases.some(db => db.role === 'superset' && db.database === 'superset'))
  },
  'ARCH-SCHEMA-BASELINE': () => schema(),
  'ARCH-SCHEMA-VERIFY': () => schema(),
  'ARCH-IDENTITY-GUARD': () => currentIdentity()
}

export async function verifyArchitecture(facts = sourceFacts(), model = undefined) {
  model ??= await modelAt()
  checkArchitecture(model, facts.compose)
  const anchors = validateBindings()
  const results = rules.map(rule => {
    const run = configuration[rule.id]
    assert(typeof run === 'function', 'Rule has no implementation: ' + rule.id)
    try {
      run(model, facts)
      return { id: rule.id, claim: rule.claim_id, configuration: 'checked', runtime: rule.runtime ? 'unverified' : 'not-required' }
    } catch (error) {
      return { id: rule.id, claim: rule.claim_id, configuration: 'violated', message: error.message,
        runtime: rule.runtime ? 'unverified' : 'not-required' }
    }
  })
  return { scope: 'local-compose', sources: facts.sourceHashes, anchors: Object.fromEntries(anchors), results }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await verifyArchitecture()
    console.log(JSON.stringify(report, null, 2))
    if (report.results.some(rule => rule.configuration === 'violated')) process.exitCode = 1
  } catch (error) {
    console.log(JSON.stringify({ scope: 'local-compose', state: 'UNKNOWN', message: error.message }))
    process.exitCode = 1
  }
}
