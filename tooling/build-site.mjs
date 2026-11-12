import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lock, modelAt, modelFingerprint, modelViews, root } from './model.mts'
import { verifyArchitecture } from './validate-model.mts'

// A new static build must not inherit a previous publication's status/receipt.
for (const file of ['status.json', 'runtime-evidence.json']) await rm(join(root, 'dist', file), { force: true })

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const model = await modelAt()
const verification = await verifyArchitecture(undefined, model)
assert(verification.results.every(rule => rule.configuration === 'checked'), 'Architecture configuration check failed')
const views = modelViews(model)
const checkedAt = new Date().toISOString()
const checkedLabel = new Intl.DateTimeFormat('de-CH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich'
}).format(new Date(checkedAt))
const diagrams = join(root, 'dist/diagrams')
execFileSync(join(root, 'node_modules/.bin/likec4'), [
  'build', 'src', '--output', diagrams, '--base', './', '--use-hash-history',
  '--title', 'Dateninfrastruktur', '--no-build-webcomponent'
], { cwd: root, stdio: 'inherit' })

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const cards = views.map(view => `<li><a href="./diagrams/#/view/${escape(view.id)}">
  <span class="number">${escape(view.id)}</span><strong>${escape(view.title)}</strong>
  <span>${escape(view.description?.text ?? '')}</span></a></li>`).join('')
const commits = Object.entries({ workspace: lock.workspace, ...lock.products }).map(([id, sha]) =>
  `<tr><th scope="row">${escape(id)}</th><td><code>${escape(sha)}</code></td></tr>`).join('')

await writeFile(join(root, 'dist/index.html'), `<!doctype html>
<html lang="de-CH"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dateninfrastruktur · Lokale Ist-Architektur</title>
<style>
  :root { color-scheme: light; --ink: #16243b; --muted: #45556e; --line: #d9e2ee; --blue: #194c8e; --page: #f4f7fb; }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); background: var(--page); font: 1rem/1.55 system-ui, sans-serif; }
  main { max-width: 75rem; padding: clamp(1.2rem, 4vw, 3rem); margin: auto; }
  header { padding-bottom: 1.5rem; border-bottom: 1px solid var(--line); }
  .eyebrow, .number { color: var(--blue); font-size: .83rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  h1 { margin: .2rem 0 .5rem; font-size: clamp(2.05rem, 5vw, 3.2rem); line-height: 1.1; letter-spacing: -.035em; }
  h2 { font-size: 1.4rem; margin: 0 0 .8rem; }
  p { margin: .5rem 0 0; max-width: 72ch; }
  section { margin-top: 1.9rem; }
  ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: .85rem; padding: 0; list-style: none; }
  li { display: flex; }
  li a { flex: 1; display: grid; align-content: start; gap: .35rem; padding: .9rem 1rem; border: 1px solid var(--line);
    border-radius: .75rem; background: white; text-decoration: none; color: var(--ink); }
  li a:hover, li a:focus-visible { border-color: var(--blue); box-shadow: 0 0 0 2px #b6d1ef; }
  li a span:last-child, .details { color: var(--muted); }
  li strong { font-size: 1.05rem; }
  table { width: 100%; border-collapse: collapse; margin-top: .9rem; text-align: left; }
  th, td { border-bottom: 1px solid var(--line); padding: .35rem .6rem .35rem 0; }
  code, #observation li { overflow-wrap: anywhere; }
  #observation ul { display: block; }
  a { color: var(--blue); }
</style></head>
<body><main>
<header><div class="eyebrow">Lokales Compose-System</div>
<h1>Dateninfrastruktur</h1>
<p>Technische Ist-Architektur für Katalog, Fachrechte, CSV-Anlieferung, Downloads und Analytics.</p></header>
<section aria-labelledby="views"><h2 id="views">Architektursichten</h2><ul>${cards}</ul></section>
<section aria-labelledby="status"><h2 id="status">Prüfstand</h2>
<p><strong>Quellen und Modell geprüft</strong> · Modell ${escape(pkg.version)} · LikeC4 ${escape(pkg.devDependencies.likec4)}</p>
<p id="freshness"><strong>Aktualität unbekannt</strong></p>
<p class="details">Prüfzeitpunkt <time datetime="${checkedAt}">${checkedLabel}</time>. <span id="runtime-status">Ausgewählte Laufzeitnachweise stehen aus.</span> <span id="remote-status">Remote-SHAs wurden noch nicht verglichen.</span></p>
<p><a id="runtime-evidence" href="./runtime-evidence.json" hidden>Gebundene Laufzeitabnahme</a></p>
<table><thead><tr><th>Repository</th><th>Geprüfter Quellcommit</th></tr></thead><tbody>${commits}</tbody></table>
<div id="observation" hidden><p>Zuletzt beobachteter Quellenstand <time></time></p><ul></ul></div></section>
<section aria-labelledby="scope"><h2 id="scope">Betriebsgrenze</h2>
<p>Das Deployment zeigt Loopback-Ports und das interne Compose-Netz. PostgreSQL speichert die fachliche Annahme. ClickHouse stellt den separaten technischen SQL-Zugang bereit.</p>
<p>Für die fachliche Kommunikation gibt es die separate <a href="https://github.com/sogis/dateninfrastruktur-diagramm">draw.io-Übersicht</a>.</p></section>
</main><script type="module" src="./status-view.mjs"></script></body></html>\n`)
await writeFile(join(root, 'dist/verification.json'), JSON.stringify({
  scope: 'local-compose', checkedAt, modelVersion: pkg.version, likec4: pkg.devDependencies.likec4,
  sourceLock: lock, modelSha256: modelFingerprint(), runtime: 'unverified', remoteComparison: null, rules: verification.results
}, null, 2) + '\n')
await copyFile(join(root, 'tooling/status-view.mjs'), join(root, 'dist/status-view.mjs'))
