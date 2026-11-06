import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertDownloadBoundary, checkArchitecture, checkFlowSemantics, modelAt, modelViews, requiredViews, root } from '../tooling/model.mts'

test('seven views resolve to the same bound current architecture', async () => {
  const model = await modelAt()
  assert.deepEqual(modelViews(model).map(view => view.id), requiredViews)
  checkArchitecture(model)
})

test('flow semantics reflect real authorization and PG acceptance order', async () => {
  checkFlowSemantics(await modelAt())
})

test('a valid LikeC4 edge that bypasses the download origin is refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'di-architecture-mutation-'))
  try {
    const source = join(directory, 'src')
    await cp(join(root, 'src'), source, { recursive: true })
    const system = join(source, 'model/system.c4')
    const original = await readFile(system, 'utf8')
    await writeFile(system, original.replace("  di.gateway -> di.origin 'Leitet den freigegebenen Download weiter'",
      "  di.gateway -> di.origin 'Leitet den freigegebenen Download weiter'\n  di.gateway -> di.garage 'Falscher Bypass'"))
    const model = await modelAt(source)
    assert(model.relationships().some(relation => relation.source.id === 'di.gateway' && relation.target.id === 'di.garage'))
    assert.throws(() => assertDownloadBoundary(model), /bypasses/)
  } finally {
    await rm(directory, { recursive: true })
  }
})
