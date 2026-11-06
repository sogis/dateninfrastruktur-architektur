const labels = {
  VERIFIED: 'Beobachteter und verifizierter Stand stimmen überein',
  EVIDENCE_ONLY: 'Neuer Commit enthält ausschliesslich Berichtsänderungen',
  CHECKING: 'Neuere Quellen werden geprüft',
  DRIFT: 'Neuer Quellenstand weicht ab',
  VIOLATION: 'Verbindliche Architekturregel verletzt',
  NOT_VERIFIABLE: 'Beobachteter Stand nicht vollständig prüfbar',
  SUPERSEDED: 'Prüflauf durch einen neueren Quellenstand überholt'
}
const sha = /^[a-f0-9]{40}$/
const consistent = (set, expected) => set?.workspace === expected.workspace &&
  Object.keys(expected.products).every(id => set?.products?.[id] === expected.products[id])

export function statusPresentation(state, expected, modelSha, now = Date.now()) {
  const compared = Date.parse(state?.observed_at ?? '')
  if (!state || !labels[state.comparison_status] || !Number.isFinite(compared) || compared > now + 60000 ||
      now - compared > 36 * 3600000 || !sha.test(state.observed_source_set?.workspace ?? '')) {
    return { label: 'Aktualität unbekannt', runtime: false, observedAt: null, observed: null }
  }
  if (state.comparison_status === 'VERIFIED' && (!state.verified_source_set ||
      !consistent(state.observed_source_set, state.verified_source_set))) {
    return { label: 'Aktualität unbekannt', runtime: false, observedAt: null, observed: null }
  }
  const runtime = consistent(state.verified_source_set, expected) && /^[a-f0-9]{64}$/.test(modelSha ?? '') &&
    state.verified_model_sha256 === modelSha && /^[a-f0-9]{64}$/.test(state.evidence_sha256 ?? '') &&
    ['DYN-DOWNLOAD', 'DYN-RIGHTS', 'DYN-INGESTION'].every(id => state.coverage?.includes(id))
  const observed = { workspace: state.observed_source_set.workspace,
    ...Object.fromEntries(Object.entries(state.observed_source_set.products ?? {})
      .filter(([id, value]) => Object.hasOwn(expected.products, id) && sha.test(value))) }
  return { label: labels[state.comparison_status], runtime, verifiedAt: state.verified_at,
    observedAt: state.observed_at, observed, comparisonSource: state.comparison_source }
}

if (typeof document !== 'undefined') {
  try {
    const [status, site] = await Promise.all(['status.json', 'verification.json'].map(async path => {
      const response = await fetch(path, { cache: 'no-store' })
      if (!response.ok) throw new Error('Statuskanal nicht erreichbar')
      return response.json()
    }))
    const state = statusPresentation(status, site.sourceLock, site.modelSha256)
    document.querySelector('#freshness').textContent = state.label
    if (state.runtime) {
      document.querySelector('#runtime-status').textContent =
        'Ausgewählte lokale Download-, Rechte- und Anlieferungsnachweise gelten für den angezeigten Quellstand.'
      document.querySelector('#runtime-evidence').hidden = false
    }
    if (state.comparisonSource === 'remote-branches') document.querySelector('#remote-status').textContent =
      'Die Tabelle der Beobachtung zeigt den zuletzt verglichenen Remote-Stand.'
    if (state.comparisonSource === 'diagnostic-product-pr') document.querySelector('#remote-status').textContent =
      'Die Beobachtung stammt aus einer kontrollierten Prüfung eines Produkt-PRs.'
    if (state.observedAt) {
      const section = document.querySelector('#observation')
      const label = new Intl.DateTimeFormat('de-CH', { dateStyle: 'medium', timeStyle: 'short',
        timeZone: 'Europe/Zurich' }).format(new Date(state.observedAt))
      section.hidden = false
      section.querySelector('time').dateTime = state.observedAt
      section.querySelector('time').textContent = label
      for (const [id, commit] of Object.entries(state.observed)) {
        const row = document.createElement('li')
        row.textContent = id + ' ' + commit
        section.querySelector('ul').append(row)
      }
    }
  } catch {
    // The initial state remains unknown when the separate observation channel is unavailable.
  }
}
