# Lokaler Betrieb und Prüfung

Der [Entwicklungsstack](../../dateninfrastruktur-dev-stack/README.md) betreibt zehn dauerhafte Dienste in einem Compose-Projekt. Setup- und Testprofile sind explizite Werkzeuge. PostgreSQL, Garage, Admin, Sodata, Jenkins und der Origin verwenden interne Dienstadressen.

`dev.sh admin on` ersetzt den laufenden Admin-Dienst im selben Compose-Projekt
durch Gradle `bootRun`. APISIX nutzt auch in diesem Modus `admin:8080` für
Management, CSS und die Download-Autorisierungsprüfung. Der Container liest CSS
und JTE aus dem Checkout. Erfolgreich kompilierte Java-Änderungen starten den
Spring-Anwendungskontext neu. `dev.sh admin off` stellt das zuvor verwendete
Image wieder her.

| Loopback-Port des lokalen Rechners | Standardziel im Container |
| --- | --- |
| `127.0.0.1:GATEWAY_PORT` | APISIX `9080` |
| `127.0.0.1:18080` | Keycloak `8080` |
| `127.0.0.1:18088` | Superset `8088` |
| `127.0.0.1:18123` und `127.0.0.1:19000` | ClickHouse `8123` und `9000` |

Benannte Volumes speichern PostgreSQL, Garage-Daten und -Metadaten, Jenkins-Home, ClickHouse-Daten und -Logs sowie Superset-Home. Private Runtime-Dateien liefern gerenderte Konfiguration und explizite lokale Zugangsdaten. Der Origin bindet seine rclone-Konfiguration read-only ein.

## Datenbankschema

Das explizite Freshsetup importiert die aktuellen INTERLIS-Modelle mit gepinntem ili2pg und ergänzt die im Manifest gebundene technische SQL-Baseline. Der normale Start prüft den verpackten und physischen Vertrag lesend. Die Betriebsprüfung verwendet den aktuellen Setup-Verifier. [Schema-Manifest](../../dateninfrastruktur-admin/db/schema/manifest.json)

## Prüfstand

Der lokale Quellenlock pinnt alle untersuchten Produktstände. Die statische Website zeigt den Umfang, die Modellversion und den Prüfzeitpunkt des Builds. Ihre Quell- und Konfigurationsaussagen beruhen auf diesem Satz. Laufzeitnachweise für die ausgewählten Architekturabläufe werden separat geführt. Ein Remotevergleich liegt in diesem lokalen Build nicht vor. [Prüfdeckung](../contracts/coverage.json)

## Testauswahl

`npm run check` prüft den gepinnten Quellenstand, die Modellgrenzen und die festen Regeln. Der Bericht trennt die statische Prüfung von ausstehenden Laufzeitnachweisen. Die Faktenextraktion liest Compose mit synthetischen Werten direkt aus dem gebundenen Git-Commit.

`npm run select -- changes.json` nimmt eine Liste von Objekten mit `repo_id` und `path` entgegen und gibt betroffene Checks mit Gründen aus. Gemeinsame Schema- und Laufzeitänderungen betreffen mehrere Szenarien. Unbekannte Pfade ergeben `UNKNOWN` und benötigen einen Quellenabgleich. Eine reine Markdown-Änderung wählt nur die Dokumentationsprüfung.

## Quellenabgleich

`npm run reconcile` friert die lokalen Git-HEADs ein. Die Statusdatei liegt unter `.runtime/status.json`. Ein früher verifizierter Stand und neu beobachtete SHAs bleiben getrennt. Ein bewilligter lokaler Laufzeitbeleg kann mit `npm run reconcile -- --evidence <Verzeichnis> <SHA256>` gebunden werden. Der Digest bezeichnet den geprüften Laufzeitmanifest-Beleg. Die Website kann die daraus erzeugte Statusdatei separat unter `dist/status.json` lesen.

Der Statuskanal verwendet ein tägliches Vergleichsintervall mit zwölf Stunden Toleranz. Die Anzeige meldet einen nicht erreichbaren oder länger ausgefallenen Kanal als unbekannt. [Vorbereitete Aktivierung](../ACTIVATION.md)
