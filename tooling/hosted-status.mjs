import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const commit = /^[a-f0-9]{40}$/
const hash = /^[a-f0-9]{64}$/
const states = new Set(['VERIFIED', 'EVIDENCE_ONLY', 'DRIFT', 'VIOLATION', 'NOT_VERIFIABLE', 'SUPERSEDED'])
const modes = new Set(['remote-branches', 'diagnostic-product-pr'])
const staticCoverage = ['source-checked', 'configuration-checked']
const dynamicCoverage = ['DYN-DOWNLOAD', 'DYN-RIGHTS', 'DYN-INGESTION']

function sourceSet(value, expected) {
  assert(value?.schema_version === 1 && commit.test(value.workspace) && value.products)
  const ids = Object.keys(expected.products).sort()
  assert.deepEqual(Object.keys(value.products).sort(), ids)
  assert(ids.every(id => commit.test(value.products[id])))
  return { schema_version: 1, workspace: value.workspace,
    products: Object.fromEntries(ids.map(id => [id, value.products[id]])) }
}

function epoch(value) {
  assert(Number.isSafeInteger(value) && value > 0, 'Invalid workflow ordering value')
  return value
}

export function mergeHostedStatus(site, observation, previous, run, attestation = null) {
  const runNumber = epoch(run.number)
  const runAttempt = epoch(run.attempt)
  assert(/^\d+$/.test(run.id), 'Invalid GitHub run ID')
  if (previous) {
    const prior = epoch(previous.workflow_run_number)
    const attempt = epoch(previous.workflow_run_attempt)
    if (prior > runNumber || prior === runNumber && attempt >= runAttempt) return null
  }

  const basis = sourceSet(site.sourceLock, site.sourceLock)
  assert(site.scope === 'local-compose' && hash.test(site.modelSha256) && Number.isFinite(Date.parse(site.checkedAt)))
  assert(Array.isArray(site.rules) && site.rules.length > 0 && site.rules.every(rule => rule.configuration === 'checked'))
  const seen = observation ?? previous
  const observed = seen?.observed_source_set ? sourceSet(seen.observed_source_set, basis) : null
  const observedAt = seen?.observed_at ?? null
  assert(observedAt === null || Number.isFinite(Date.parse(observedAt)))

  let status = 'NOT_VERIFIABLE'
  if (observation) {
    assert(states.has(observation.comparison_status) && modes.has(observation.comparison_source) && observed && observedAt)
    status = observation.comparison_status
  }
  const match = JSON.stringify(observed) === JSON.stringify(basis)
  const observedCoverage = staticCoverage.filter(value => observation?.observed_coverage?.includes(value))
  if (status === 'NOT_VERIFIABLE' && match && observedCoverage.length === staticCoverage.length) status = 'VERIFIED'
  assert(status !== 'VERIFIED' || match, 'Verified observation differs from the published snapshot')

  let evidence = null
  if (attestation) {
    assert.deepEqual(sourceSet(attestation.source_set, basis), basis, 'Runtime evidence belongs to a different source set')
    assert.equal(attestation.model_sha256, site.modelSha256, 'Runtime evidence belongs to a different model')
    assert(hash.test(attestation.evidence_sha256) && Number.isFinite(Date.parse(attestation.verified_at)))
    assert.deepEqual(attestation.scenarios, dynamicCoverage)
    evidence = attestation.evidence_sha256
  }

  return {
    schema_version: 1,
    verified_source_set: basis,
    verified_model_sha256: site.modelSha256,
    verified_at: site.checkedAt,
    evidence_sha256: evidence,
    coverage: evidence ? [...staticCoverage, ...dynamicCoverage] : staticCoverage,
    observed_source_set: observed,
    observed_at: observedAt,
    observed_coverage: observedCoverage,
    comparison_status: status,
    comparison_source: modes.has(seen?.comparison_source) ? seen.comparison_source : 'remote-branches',
    error: status === 'VIOLATION' ? 'POLICY_VIOLATION' : status === 'NOT_VERIFIABLE' ? 'OBSERVATION_UNAVAILABLE' : null,
    run_id: run.id,
    workflow_run_number: runNumber,
    workflow_run_attempt: runAttempt
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [siteFile, observedFile, previousFile, output, attestationFile] = process.argv.slice(2)
  const read = (path, optional = false) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null
      throw error
    }
  }
  const next = mergeHostedStatus(read(siteFile), read(observedFile, true), read(previousFile, true), {
    number: Number(process.env.GITHUB_RUN_NUMBER), attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    id: process.env.GITHUB_RUN_ID
  }, read(attestationFile, true))
  if (next) {
    const bytes = JSON.stringify(next, null, 2) + '\n'
    writeFileSync(output, bytes)
    console.log('Published status digest: ' + createHash('sha256').update(bytes).digest('hex'))
  } else {
    console.log('Status generation already superseded')
    process.exitCode = 3
  }
}
