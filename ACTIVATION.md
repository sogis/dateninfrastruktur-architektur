# GitHub-Automatisierung und Hosting

Das Inventar bindet `sogis/dateninfrastruktur-workspace`, die sechs
Produktrepos und `sogis/dateninfrastruktur-architektur`. Der veröffentlichte
Architekturstand liegt unter [GitHub Pages](https://sogis.github.io/dateninfrastruktur-architektur/).

## Prüf- und Publikationsweg

`Architecture verification` startet bei Architektur-PRs, manuell, täglich
und durch einen Dispatch aus den geschützten Hauptbranches der Produkte.
`DI_WORKSPACE_READ_REMOTE` muss mit dem gepinnten Workspace-Inventar
übereinstimmen. Der lesende Job friert die SHAs ein, prüft die freigegebene
Website und beobachtet nach dem Abgleich die Refs erneut. Architektur-PRs
verwenden den vertrauenswürdigen Basiscommit und lesen zulässige Modelldaten
des PR-Heads ohne Schreib- oder Providergeheimnisse.

Der getrennte Publikationsjob darf nur von `main` laufen. Er persistiert
den bereinigten Beobachtungsstatus im Branch `architecture-status`. Ein
Fast-forward und der Vergleich von Laufnummer und Versuch schützen vor
älteren Läufen. Der Pages-Job benötigt `pages: write` und
`id-token: write`. Die gebaute Website und ihre Quellbindung bleiben auch
bei einer neueren Verletzung erkennbar. Bei einem seit über 36 Stunden
ausgefallenen Statuskanal zeigt die Website «Aktualität unbekannt».

Für einen lesenden Produkt-PR-Prüflauf stehen `product`, `pr` und `head`
zur Verfügung. Der Prüfer verifiziert die echte PR-Ref des Produkts.
Ein kontrollierter negativer Hosted-Test kann mit der Repository-Variablen
`DI_HOSTED_PROBE_ENABLED=true` und `publish_probe=true` separat als
Testbeobachtung ausgewiesen werden. Danach den normalen manuellen
Vergleich ausführen und die Diagnosevariable entfernen.

## Produkttrigger und Zugang

Das [Trigger-Muster](docs/templates/product-source-changed.yml.example)
verwendet `DI_PRODUCT_ID` aus dem Inventar und
`DI_ARCH_DISPATCH_APP_ID` als Variable. `DI_ARCH_DISPATCH_PRIVATE_KEY`
ist ein Repository-Secret der freigegebenen Produkte. Die private App
`sogis-di-architecture-dispatch` ist ausschliesslich am Architekturrepo
installiert. Die gepinnte Action erzeugt pro Lauf ein kurzlebiges Token
mit `Contents: write` am Ziel. Der zentrale Job akzeptiert nur den
Dispatch-Absender dieser App. [GitHub REST Dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)

## Nachweisumfang

Diesen Hosted-Stand belegen Quell-, Konfigurations- und Modellprüfungen.
Dynamische Nachweise brauchen die gepinnte GRETL-/Jenkins-Toolchain, deren
Offline-Bundle sowie einen isolierten Compose-Kontext. Ein geprüfter
Laufzeitnachweis kann als bereinigter Digest mit exaktem Quellsatz und
Modellhash freigegeben werden. Ohne passenden Nachweis bleibt die
Laufzeitabdeckung offen. Die Website veröffentlicht keine Rohbelege.
[GitHub Actions Secure use](https://docs.github.com/en/actions/reference/security/secure-use)

`npm run reconcile -- --proposal` erzeugt lokal einen begrenzten Vorschlag
für legitime Drift. Der Architektur-Maintainer lässt semantische Änderungen
unabhängig prüfen und gibt sie über den geschützten Hauptbranch frei.
