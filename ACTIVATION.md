# Remote-Aktivierung

Status `REMOTE_NOT_ACTIVATED`. Die Architektur hat lokal ein eigenes Repository. Das tatsächliche Workspace-Remote ist weiterhin `sogis/dateninfrastruktur-checkout`. Für `sogis/dateninfrastruktur-architektur` ist die GitHub-Anlage und für den Workspace-Namen eine separate Freigabe erforderlich. Das Inventar enthält die tatsächlichen Remotes.

## Vorbereitete Jobs

Der zentrale Workflow prüft die festgeschriebenen Quellen mit `npm ci`, `npm run validate`, `npm run test:architecture` und `npm run build`. Er verwendet `DI_WORKSPACE_READ_REMOTE` aus den Repository-Variablen. Der Wert muss zur Remote-Angabe im gepinnten Workspace-Inventar passen. Das PR-Ereignis startet mit dem vertrauenswürdigen Basiscommit und prüft zulässige Modelldaten des PR-Heads ohne Schreib- oder Providergeheimnisse. Änderungen an Prüfern und Regeln brauchen den verantwortlichen Review.

Ein zentraler manueller Prüflauf mit den Eingaben `product`, `pr` und `head` bindet einen Produkt-PR an die gepinnten Geschwisterquellen. Er prüft die Herkunft über die PR-Ref des freigegebenen Produktrepos und schreibt einen separaten Kandidatenbefund. Ein Bedarf an weiterem Review oder fehlende Laufzeitbelege bleibt im Lauf sichtbar. Zentraler Vergleich und Website übernehmen erst freigegebene Quellen. Ohne Eingaben beobachtet der manuelle Lauf die Hauptbranches.

Nach expliziter Einrichtung können Produktrepos das Trigger-Muster auf ihrem geschützten Hauptbranch installieren. Setze dort `DI_PRODUCT_ID` aus dem Workspace-Inventar und `DI_ARCH_DISPATCH_APP_ID` als Variable. Hinterlege `DI_ARCH_DISPATCH_PRIVATE_KEY` nur in den dafür freigegebenen Produktrepos. Die gepinnte Action erzeugt pro Lauf ein kurzlebiges Installationstoken für das Architekturrepo. Für den Dispatch braucht dieses Token `Contents: write` am Zielrepository. Der zentrale Lauf selbst verwendet `contents: read`. [Trigger-Muster](docs/templates/product-source-changed.yml.example) · [GitHub REST Dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)

Die Trigger sind geschützte Produktänderung, zentraler `repository_dispatch`, manueller `workflow_dispatch` und tägliche Beobachtung. Der zentrale Abgleich friert die beobachteten SHAs ein und prüft nach dem Lauf erneut die Hauptbranches. Der Statuskanal publiziert den Beobachtungsstatus separat vom verifizierten Stand.

## Vertrauensgrenzen und Testumfang

Die lokalen Architektur-, Vertrags- und Browsertests benötigen Node 22.23.1, npm 11.18.0 und Chromium. Die dynamischen Prüfungen brauchen die gebundene GRETL-/Jenkins-Toolchain, isoliertes Compose und die lokal überprüften Image- und JAR-Bindungen. Ein normaler Hosted-Runner liefert statische Belege. Für dynamische Belege ist ein ausdrücklich freigegebener isolierter Runner mit dem gleichen Offline-Bundle nötig. Untrusted PRs verwenden keine Nutzer- oder Providercredentials. [GitHub Actions Secure use](https://docs.github.com/en/actions/reference/security/secure-use)

`npm run reconcile -- --proposal` kann lokal für legitime Drift einen begrenzten Patch erzeugen. Der Vorschlag enthält Quellanker, bleibt bis zum unabhängigen Review offen und wird separat veröffentlicht. Ein Policyverstoss oder unbekannter Stand erzeugt einen Befund. Die Freigaberegeln und der erforderliche Review des Architekturrepos werden erst nach Aktivierung eingerichtet.

## Siteziel

Vorgesehen ist GitHub Pages unter dem freigegebenen Architektur-Repository. `dist` verwendet relative Assets und Hashnavigation. Der freigegebene Site-Snapshot erhält separat `status.json` aus dem geschützten Statuslauf. Bei ausgefallenem oder älter als 36 Stunden altem Statuskanal zeigt die Site «Aktualität unbekannt». Die Freigabe muss reale Trigger, Driftanzeige und veröffentlichte Quell-SHAs unabhängig bestätigen.

Für die Aktivierung verbindet der verantwortliche Architektur-Maintainer den geschützten Publikationsjob mit dem freigegebenen Ziel `https://sogis.github.io/dateninfrastruktur-architektur/`. Der Job muss die letzte freigegebene Modell-/Evidenzbindung dauerhaft übernehmen und aus zentralen Läufen den separaten Beobachtungsstatus auch bei fachlichem Fehler publizieren. Ein älterer Lauf darf die beobachtete Generation nur mit erfolgreichem Vergleich der zuletzt publizierten Generation ersetzen. Der lesende Workflow liefert dafür ausschliesslich bereinigte Beobachtungsdaten. Bei privaten Quellen ist ein separat genehmigter lesender Zugriff auf die im Inventar bezeichneten Repos erforderlich.
