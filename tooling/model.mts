import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LikeC4 } from 'likec4'
import { extractComposeFacts } from './facts.mts'
import { lock, pinnedSource, resolveBinding, root, selectSource, sha256 } from './sources.mts'

export { lock, root }

export async function modelAt(source = join(root, 'src')) {
  const language = await LikeC4.fromWorkspace(source, { logger: false })
  return language.computedModel()
}

export const requiredViews = ['V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07']
export function modelFingerprint() {
  const src = join(root, 'src')
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(src.length + 1)).sort()
  return sha256(JSON.stringify(files.map(file => [file, sha256(readFileSync(join(src, file)))])))
}

export function modelViews(model) {
  return requiredViews.map(id => model.view(id))
}

export function assertDownloadBoundary(model) {
  const links = [...model.relationships()].map(relation => [relation.source.id, relation.target.id])
  for (const pair of [['di.gateway', 'di.admin.authz'], ['di.gateway', 'di.origin'], ['di.origin', 'di.garage']]) {
    assert(links.some(link => link.every((value, index) => value === pair[index])), 'Missing download boundary: ' + pair.join(' → '))
  }
  assert(!links.some(([from, to]) => from === 'di.gateway' &&
    (to === 'di.garage' || to === 'di.postgres' || to.startsWith('di.postgres.'))),
  'Gateway bypasses the download authorization or origin boundary')
}

export function checkArchitecture(model, compose = extractComposeFacts(pinnedSource({ repo_id: 'stack', path: 'compose.yaml' }))) {
  const running = Object.entries(compose.services).filter(([, service]) => service.classification === 'runtime').map(([name]) => 'di.' + name)
  const nodes = id => [...model.view(id).nodes()].map(node => node.id).sort()
  assert.deepEqual([...model.children('di')].map(node => node.id).sort(), running.sort())
  assert.deepEqual(nodes('V02'), running)
  assert(model.view('V07').isDeploymentView())
  assert.deepEqual(nodes('V07').filter(id => id.startsWith('local.compose.')),
    running.map(id => 'local.compose.' + id.slice(3)))
  assert.deepEqual([...model.children('di.postgres')].map(node => node.id).sort(),
    ['di.postgres.keycloakDb', 'di.postgres.managementDb', 'di.postgres.supersetDb'])
  assert(model.view('V04').isDynamicView() && model.view('V05').isDynamicView() && model.view('V06').isDynamicView())
  assertDownloadBoundary(model)
  const bindings = JSON.parse(readFileSync(join(root, 'contracts/source-bindings.json'), 'utf8'))
  const coverage = JSON.parse(readFileSync(join(root, 'contracts/coverage.json'), 'utf8'))
  const claims = bindings.claims.map(claim => claim.claim_id)
  assert.equal(new Set(claims).size, claims.length)
  assert.deepEqual(Object.keys(coverage.claims).sort(), claims.sort())
  for (const claim of bindings.claims) {
    assert(claim.view_ids.every(id => requiredViews.includes(id)))
    assert(claim.check_ids.every(id => id.startsWith('ARCH-')))
    for (const source of claim.sources) resolveBinding(source)
  }
}

export function checkFlowSemantics(model) {
  const routeFile = pinnedSource({ repo_id: 'stack', path: 'services/apisix/routes.template.json' })
  const route = selectSource(routeFile, { kind: 'json-object', collection: 'routes', id: 'download' })
  const auth = route.plugins['forward-auth']
  assert.equal(auth.uri, 'http://admin:8080/internal/authorization/check')
  assert.equal(auth.allow_degradation, false)
  assert.equal(auth.status_on_error, 503)
  assert.deepEqual(Object.keys(route.upstream.nodes), ['origin:8080'])
  assertDownloadBoundary(model)

  const edges = id => [...model.view(id).edges()]
  const step = (list, from, to, text) =>
    list.findIndex(edge => edge.source.id === from && edge.target.id === to && edge.label.includes(text))
  const delivery = edges('V04')
  const commit = step(delivery, 'di.admin.publication', 'di.postgres.managementDb', 'COMMITTED')
  const project = step(delivery, 'di.admin.projector', 'di.clickhouse', 'Projektion')
  const confirm = step(delivery, 'di.admin.projector', 'di.postgres.managementDb', 'Quittiert')
  assert(commit >= 0 && project > commit && confirm > project, 'Publication sequence differs')
  assert(delivery.some(edge => edge.label.includes('bisherige Stand bleibt gültig')))
  assert(delivery.some(edge => edge.source.id === 'di.jenkins' && edge.target.id === 'di.jenkins' &&
    edge.label.includes('Jenkins-Spool')))
  const download = edges('V06')
  const permission = step(download, 'di.gateway', 'di.admin.authz', 'forward-auth')
  const forward = step(download, 'di.gateway', 'di.origin', 'freigegebenen')
  assert(permission >= 0 && forward > permission, 'Download authorization must precede origin')
  assert(edges('V05').some(edge => edge.label.includes('Antrag am Datensatz')))
  assert(edges('V05').some(edge => edge.label.includes('Widerruf und Audit')))
}
