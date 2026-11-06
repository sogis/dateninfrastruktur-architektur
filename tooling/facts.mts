import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { pinnedSource, sha256 } from './sources.mts'

type Spec = Record<string, unknown>
type Environment = Record<string, string>
const allowedProfiles = new Set(['setup', 'test', 'tools', 'build-tools'])
const synthetic: Environment = {
  GATEWAY_PORT: '18081', RUNTIME_DIR: '/synthetic/runtime', DI_STORAGE_BUCKET: 'ch.so.daten',
  DI_STORAGE_ENDPOINT: 'http://garage:3900', DI_STORAGE_REGION: 'garage',
  POSTGRES_VOLUME: 'synthetic_postgres', SUPERSET_VOLUME: 'synthetic_superset',
  JENKINS_VOLUME: 'synthetic_jenkins', GARAGE_META_VOLUME: 'synthetic_garage-meta',
  GARAGE_DATA_VOLUME: 'synthetic_garage-data', CLICKHOUSE_DATA_VOLUME: 'synthetic_clickhouse-data',
  CLICKHOUSE_LOG_VOLUME: 'synthetic_clickhouse-logs'
}

function interpolate(value: unknown, env: Environment) {
  const rendered = String(value).replace(/\$\{([A-Z][A-Z0-9_]*)(?::([-?])([^{}]*))?\}/g,
    (_, key: string, operator: string, fallback: string) =>
      env[key] ?? (operator === '-' ? fallback : 'synthetic-' + key.toLowerCase()))
  assert(!rendered.includes('${'), 'Unknown Compose interpolation')
  return rendered
}

function object(value: unknown, description: string): Spec {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected ' + description)
  return value as Spec
}

function port(value: unknown, env: Environment) {
  if (typeof value === 'object' && value) {
    const spec = object(value, 'Compose port mapping')
    return { host: String(spec.host_ip ?? ''), published: Number(interpolate(spec.published ?? 0, env)),
      target: Number(spec.target), protocol: String(spec.protocol ?? 'tcp') }
  }
  const parsed = /^(?:(\[[^\]]+\]|[^:]+):)?(?:([0-9]+):)?([0-9]+)(?:\/(tcp|udp))?$/.exec(interpolate(value, env))
  assert(parsed, 'Unsupported Compose port mapping')
  const [, host = '', published = '0', target, protocol = 'tcp'] = parsed
  return { host, published: Number(published), target: Number(target), protocol }
}

function environment(value: unknown): Spec {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map(row => {
      assert(typeof row === 'string' && row.includes('='), 'Unbound Compose environment name')
      const separator = row.indexOf('=')
      return [row.slice(0, separator), row.slice(separator + 1)]
    }))
  }
  return object(value ?? {}, 'Compose environment')
}

function pg(role: string, value: unknown) {
  const url = new URL(String(value).replace(/^jdbc:/, ''))
  assert.equal(url.protocol, 'postgresql:')
  assert(!url.username && !url.password && !url.search, 'Unexpected credentials in PostgreSQL endpoint')
  return { role, server: url.hostname, database: url.pathname.slice(1), port: Number(url.port || 5432) }
}

export function extractComposeFacts(source: string, values: Environment = synthetic) {
  const input = object(parse(source, { uniqueKeys: true }), 'Compose document')
  assert(!input.include, 'Compose include requires a separately bound source')
  const entries = Object.entries(object(input.services, 'Compose services'))
  const services = Object.fromEntries(entries.map(([id, raw]) => {
    const spec = object(raw, 'Compose service ' + id)
    assert(!spec.extends, 'Compose extends requires a separately bound source')
    const profiles = spec.profiles ?? []
    assert(Array.isArray(profiles) && profiles.every(p => allowedProfiles.has(p)),
      'Unknown Compose service classification: ' + id)
    const env = environment(spec.environment)
    const dependencies = Array.isArray(spec.depends_on) ? spec.depends_on : Object.keys(object(spec.depends_on ?? {}, 'depends_on'))
    const builds = typeof spec.build === 'string' ? { context: interpolate(spec.build, values) } :
      spec.build ? Object.fromEntries(Object.entries(object(spec.build, 'Compose build')).filter(([key]) =>
        ['context', 'dockerfile', 'target', 'additional_contexts'].includes(key)).map(([key, value]) =>
        [key, typeof value === 'string' ? interpolate(value, values) : value])) : null
    const ports = spec.ports ?? []
    const mounts = spec.volumes ?? []
    assert(Array.isArray(ports) && Array.isArray(mounts), 'Invalid Compose ports or mounts')
    const command = Array.isArray(spec.command) ? spec.command.map(value => interpolate(value, values)) : []
    return [id, {
      classification: profiles.length ? profiles.join('+') : 'runtime',
      startupDependencies: [...dependencies].sort(), builds, envNames: Object.keys(env).sort(),
      ports: ports.map(value => port(value, values)),
      mounts: mounts.map(value => typeof value === 'string' ? interpolate(value, values) : value),
      command: id === 'origin' ? command : [],
      env
    }]
  }))
  const admin = services.admin?.env ?? {}
  const sodata = services.sodata?.env ?? {}
  const keycloak = services.keycloak?.env ?? {}
  const superset = services.superset?.env ?? {}
  const databases = [
    pg(String(admin.DI_MANAGEMENT_WRITER_USERNAME), admin.DI_MANAGEMENT_WRITER_JDBCURL),
    pg(String(admin.DI_MANAGEMENT_AUTHORIZATION_USERNAME), admin.DI_MANAGEMENT_AUTHORIZATION_JDBCURL),
    pg(String(admin.DI_MANAGEMENT_AUDIT_USERNAME), admin.DI_MANAGEMENT_AUDIT_JDBCURL),
    pg(String(sodata.DATENINFRASTRUKTUR_CATALOG_DATABASE_USERNAME), sodata.DATENINFRASTRUKTUR_CATALOG_DATABASE_JDBCURL),
    pg(String(keycloak.KC_DB_USERNAME), keycloak.KC_DB_URL),
    pg(String(superset.SUPERSET_DB_USER), 'postgresql://' + superset.SUPERSET_DB_HOST + '/' + superset.SUPERSET_DB_NAME)
  ]
  const storageBucket = interpolate(services['garage-setup']?.env?.DI_STORAGE_BUCKET, values)
  const safeServices = Object.fromEntries(Object.entries(services).map(([id, { env, ...facts }]) => [id, facts]))
  return {
    services: safeServices, databases, storageBucket,
    namedVolumes: Object.keys(object(input.volumes ?? {}, 'Compose volumes')).sort(),
    networkNames: Object.keys(object(input.networks ?? {}, 'Compose networks')).sort()
  }
}

export function extractGatewayFacts(source: string) {
  const input = JSON.parse(source)
  assert(Array.isArray(input.routes), 'Missing active routes')
  const routes = new Map()
  for (const route of input.routes) {
    assert(typeof route.id === 'string' && !routes.has(route.id), 'Duplicate or missing gateway route ID')
    const plugins = object(route.plugins ?? {}, 'Gateway plugins')
    const forward = plugins['forward-auth']
    const auth = forward ? object(forward, 'forward-auth config') : null
    routes.set(route.id, {
      matches: route.uris ?? (route.uri ? [route.uri] : []),
      upstreams: Object.keys(route.upstream?.nodes ?? {}).sort(),
      plugins: Object.keys(plugins).sort(),
      auth: auth && { uri: auth.uri, allowDegradation: auth.allow_degradation, errorStatus: auth.status_on_error }
    })
  }
  return Object.fromEntries(routes)
}

export function sourceFacts() {
  const compose = pinnedSource({ repo_id: 'stack', path: 'compose.yaml' })
  const routes = pinnedSource({ repo_id: 'stack', path: 'services/apisix/routes.template.json' })
  return { compose: extractComposeFacts(compose), gateway: extractGatewayFacts(routes),
    sourceHashes: { compose: sha256(compose), gateway: sha256(routes) } }
}
