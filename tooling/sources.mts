import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export type SourceLock = { schema_version: number; workspace: string; products: Record<string, string> }
export type Selector =
  | { kind: 'json-key'; keys: string[] }
  | { kind: 'json-object'; collection: string; id: string }
  | { kind: 'symbol' | 'python-symbol' | 'sql-function'; name: string }
export type SourceBinding = { repo_id: string; path: string; selector?: Selector }
type InventoryEntry = { id: string; path: string; profile: string }
type BoundRepo = { directory: string; sha: string }

export const root = fileURLToPath(new URL('..', import.meta.url))
export const workspaceRoot = dirname(root.replace(/\/$/, ''))
export const lock: SourceLock = JSON.parse(readFileSync(join(root, 'sources.lock.json'), 'utf8'))
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const commit = /^[a-f0-9]{40}$/
const identifier = /^[a-z][a-z0-9-]*$/

const gitEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']
  .filter(name => process.env[name]).map(name => [name, process.env[name]]))
const git = (directory: string, ...args: string[]) =>
  execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe']
  })

export function safePath(path: string) {
  assert(typeof path === 'string' && !isAbsolute(path) && !/[\\:\x00-\x1f]/.test(path) &&
    path.split('/').every(part => part && part !== '..' && part !== '.' && part !== '.git'),
  'Unsafe source path')
  return path
}

function boundRepo(directory: string, sha: string): BoundRepo {
  assert(commit.test(sha), 'Invalid source commit')
  const toplevel = git(directory, 'rev-parse', '--show-toplevel').trim()
  assert.equal(realpathSync(toplevel), directory, 'Repository toplevel differs')
  assert.equal(git(directory, 'cat-file', '-t', sha).trim(), 'commit', 'Source object is not a commit')
  return { directory, sha }
}

export function resolveSources(sourceLock: SourceLock, workspacePath = workspaceRoot) {
  assert.equal(sourceLock.schema_version, 1)
  const directory = realpathSync(workspacePath)
  const workspace = boundRepo(directory, sourceLock.workspace)
  const inventory: { repositories: InventoryEntry[] } =
    JSON.parse(git(directory, 'show', workspace.sha + ':repositories.json'))
  const entries = inventory.repositories.filter(entry => entry.profile === 'core' && entry.id !== 'architecture')
  const ids = entries.map(entry => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'Duplicate bound repository ID')
  assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length, 'Duplicate bound repository path')
  assert.deepEqual(Object.keys(sourceLock.products).sort(), [...ids].sort(), 'Source lock does not cover the exact product set')
  const repos = new Map<string, BoundRepo>([['workspace', workspace]])
  for (const entry of entries) {
    assert(identifier.test(entry.id), 'Invalid repository ID')
    const requested = join(directory, safePath(entry.path))
    const target = realpathSync(requested)
    const suffix = relative(directory, target)
    assert(requested === target && suffix && !suffix.startsWith('..'), 'Repository path escapes pinned workspace')
    repos.set(entry.id, boundRepo(target, sourceLock.products[entry.id]))
  }
  return repos
}

let pinned: ReturnType<typeof resolveSources> | undefined
export function pinnedSource(binding: SourceBinding, repos = pinned ??= resolveSources(lock)) {
  const repo = repos.get(binding.repo_id)
  assert(repo, 'Unknown bound repository: ' + binding.repo_id)
  return git(repo.directory, 'show', repo.sha + ':' + safePath(binding.path))
}

export function selectSource(source: string, selector: Selector) {
  switch (selector.kind) {
    case 'json-key': {
      // Anchors select from one source document. Compose applies merge semantics separately.
      const document = parse(source, {
        uniqueKeys: true,
        customTags: [{ tag: '!override', collection: 'map', resolve: node => node }],
      })
      const selected = selector.keys.reduce((value, key) => value?.[key], document)
      assert(selected !== undefined, 'Missing JSON selector: ' + selector.keys.join('/'))
      return selected
    }
    case 'json-object': {
      const rows = JSON.parse(source)[selector.collection]
      assert(Array.isArray(rows), 'Missing JSON collection: ' + selector.collection)
      const matches = rows.filter(row => row.id === selector.id)
      assert.equal(matches.length, 1, 'Ambiguous or missing JSON object: ' + selector.id)
      return matches[0]
    }
    case 'sql-function': {
      assert(/^[a-z_]+\.[a-z_]+$/.test(selector.name))
      const declarations = [...source.matchAll(/\bCREATE(?: OR REPLACE)? FUNCTION\s+([a-z_]+\.[a-z_]+)\s*\(/gi)]
      assert.equal(declarations.filter(match => match[1] === selector.name).length, 1,
        'Ambiguous or missing SQL function: ' + selector.name)
      return selector.name
    }
    case 'symbol':
    case 'python-symbol': {
      assert(/^[A-Za-z_$][\w$]*$/.test(selector.name))
      const pattern = selector.kind === 'symbol'
        ? /\b(?:class|record|interface|enum)\s+([A-Za-z_$][\w$]*)\b/g
        : /^(?:async )?def\s+([A-Za-z_][\w]*)\(/gm
      const declarations = [...source.matchAll(pattern)]
      assert.equal(declarations.filter(match => match[1] === selector.name).length, 1,
        'Ambiguous or missing declaration: ' + selector.name)
      return selector.name
    }
    default:
      throw new Error('Unknown source selector')
  }
}

export function resolveBinding(binding: SourceBinding) {
  assert(binding.selector, 'Missing source selector')
  const source = pinnedSource(binding)
  return { repo_id: binding.repo_id, path: binding.path, selector: binding.selector,
    sha256: sha256(source), value: selectSource(source, binding.selector) }
}
