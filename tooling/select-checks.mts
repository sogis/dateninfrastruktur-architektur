import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { lock, safePath } from './sources.mts'
import { bindings, rules } from './validate-model.mts'

type Change = { repo_id: string; path: string }
const scenarioRules = new Map<string, string[]>()
for (const rule of rules) {
  const list = scenarioRules.get(rule.claim_id) ?? []
  if (rule.runtime) list.push(rule.runtime)
  scenarioRules.set(rule.claim_id, list)
}
const repoIds = new Set(['workspace', 'architecture', ...Object.keys(lock.products)])
const dynamics = ['DYN-DOWNLOAD', 'DYN-RIGHTS', 'DYN-INGESTION', 'SCHEMA-BASELINE']
const schemaChecks = ['ARCH-MODEL-PERSISTENCE', 'ARCH-SCHEMA-BASELINE', 'ARCH-SCHEMA-VERIFY', 'ARCH-IDENTITY-GUARD']
const docsOnly = /(^README[.]md$|^docs\/.*[.]md$|^models\/constraints[.]md$)/
const schemaPath = /^(db\/|models\/|scripts\/(setup_explicit|audit_setup|persistence_contract|verify_physical_mapping)[.]py|src\/main\/resources\/cayenne\/|src\/main\/java\/.*\/persistence\/)/
const infrastructure = /^(compose[.]yaml|scripts\/(compose_runtime|ingestion_test_runtime|test_current_schema)[.]py|services\/postgres\/)/
const storage = /^services\/(garage|apisix)\//
const deliveryTest = /^scripts\/(test_(csv_delivery|delivery_queue|delivery_processing|submission_backend)|delivery_\w+_harness)[.]py$/

export function selectChecks(changes: Change[]) {
  const chosen = new Map<string, Set<string>>()
  const unknown: Change[] = []
  const mark = (id: string, reason: string) => {
    const reasons = chosen.get(id) ?? new Set()
    reasons.add(reason)
    chosen.set(id, reasons)
  }
  for (const change of changes) {
    const path = safePath(change.path)
    const reason = change.repo_id + ':' + path
    if (!repoIds.has(change.repo_id)) {
      unknown.push(change)
      mark('ARCH-MANUAL-REVIEW', reason)
      continue
    }
    if (docsOnly.test(path)) {
      mark('ARCH-DOCS', reason)
      continue
    }
    const matched = bindings.filter(claim =>
      claim.sources.some(source => source.repo_id === change.repo_id && source.path === path))
    for (const claim of matched) {
      for (const id of claim.check_ids) mark(id, reason)
      for (const scenario of scenarioRules.get(claim.claim_id) ?? []) mark(scenario, reason)
    }
    if (change.repo_id === 'admin' && (schemaPath.test(path) || ['Dockerfile', 'build.gradle'].includes(path))
        || change.repo_id === 'stack' && infrastructure.test(path)) {
      for (const id of [...schemaChecks, ...dynamics]) mark(id, reason + ' (gemeinsamer Schema-/Laufzeitvertrag)')
      if (change.repo_id === 'stack') {
        mark('ARCH-TOPOLOGY', reason + ' (Laufzeitgrenze)')
        mark('ARCH-PG-BOUNDARY', reason + ' (Datenbankgrenze)')
      }
    } else if (change.repo_id === 'stack' && storage.test(path)) {
      mark('DYN-DOWNLOAD', reason + ' (Gateway/Origin/Storage)')
      mark('DYN-INGESTION', reason + ' (privater Storage)')
    } else if (change.repo_id === 'stack' && deliveryTest.test(path)
        || ['jenkins', 'plugin'].includes(change.repo_id)
        || change.repo_id === 'topics' && /^(runner|contracts|models)\//.test(path)
        || change.repo_id === 'admin' && /\/ingestion\//.test(path)) {
      mark('DYN-INGESTION', reason + ' (Anlieferung)')
    } else if (change.repo_id === 'admin' && /\/(access|authorization|catalog)\//.test(path)) {
      for (const scenario of dynamics.slice(0, 3)) mark(scenario, reason + ' (gemeinsame Fachrechte)')
    } else if (change.repo_id === 'architecture' && /^(src|contracts|tooling|tests)\/|^package(-lock)?[.]json$/.test(path)) {
      mark('ARCH-MODEL', reason)
    } else if (change.repo_id === 'workspace' && /^(repositories[.]json|workspace|tooling\/)/.test(path)) {
      mark('ARCH-SOURCE-SET', reason)
    } else if (!matched.length) {
      unknown.push(change)
      mark('ARCH-MANUAL-REVIEW', reason)
    }
  }
  return {
    status: unknown.length ? 'UNKNOWN' : 'SELECTED',
    selected: [...chosen].sort(([a], [b]) => a.localeCompare(b))
      .map(([id, reasons]) => ({ id, reasons: [...reasons].sort() })),
    unknown
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = selectChecks(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  console.log(JSON.stringify(result, null, 2))
  if (result.status === 'UNKNOWN') process.exitCode = 1
}
