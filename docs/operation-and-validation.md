# Lokaler Betrieb und Prüfung

Der [Entwicklungsstack](../../dateninfrastruktur-dev-stack/README.md) betreibt zehn dauerhafte Dienste in einem Compose-Projekt. Setup- und Testprofile sind explizite Werkzeuge. PostgreSQL, Garage, Admin, Sodata, Jenkins und der Origin verwenden interne Dienstadressen.

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
