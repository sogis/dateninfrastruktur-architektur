import assert from 'node:assert/strict'
import { safePath, sha256 } from './sources.mts'

export type EvidenceContract = {
  check: string
  inputSha256: string
  testSha256: string
  toolSha256: string
  sources: Record<string, string>
  argv: string[]
  minimumAssertions: number
}

export type Evidence = {
  schema_version: 1
  contract: EvidenceContract
  result: 'PASS' | 'FAIL' | 'UNKNOWN'
  process: { exit: number; assertions: number; skipped: number; startedAt: string; finishedAt: string }
  output: { path: string; sha256: string; bytes: number }
}

export function evaluateEvidence(report: Evidence, expected: EvidenceContract, readLog: (path: string) => Buffer) {
  assert.equal(report.schema_version, 1, 'Unsupported evidence schema')
  assert.deepEqual(report.contract, expected, 'Evidence source, command, test or tool binding changed')
  assert.equal(report.result, 'PASS', 'Evidence did not pass')
  const process = report.process
  assert(process.exit === 0 && process.skipped === 0, 'Required execution failed or was skipped')
  assert(Number.isSafeInteger(process.assertions) && process.assertions >= expected.minimumAssertions &&
    expected.minimumAssertions > 0, 'No required assertions executed')
  const start = Date.parse(process.startedAt)
  const end = Date.parse(process.finishedAt)
  assert(Number.isFinite(start) && Number.isFinite(end) && start <= end, 'Invalid evidence process time')
  const bytes = readLog(safePath(report.output.path))
  assert(bytes.length === report.output.bytes && sha256(bytes) === report.output.sha256, 'Evidence bytes changed')
  const marker = 'ASSERTIONS=' + process.assertions + ' SKIP=0'
  assert(bytes.toString('utf8').split(/\r?\n/).includes(marker), 'Executed assertion marker absent')
  return true
}
