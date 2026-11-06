# Identität und Rechte

Keycloak stellt die authentisierte Identität bereit. Admin wertet die aktuelle fachliche Zuständigkeit und Freigabe am logischen Datensatz aus. Eine technische Runner-Identität bindet die Jobausführung an Dispatch, Run und Plan. `submit_data`, `manage_submitters` und fachliches Lesen sind getrennte Befugnisse.

## Berechtigungsworkflow

Ein Antrag bezieht sich auf den ganzen publizierten restricted Datensatz. Berechtigende können einen Antrag entscheiden oder innerhalb ihrer Zuständigkeit direkt einen Grant erteilen. Entscheid, Grant und Audit werden gemeinsam geschrieben. Widerruf und Ablauf wirken bei der nächsten aktuellen Fachprüfung. Ausgaben, Versionen und Distributionen übernehmen diese Zugriffsentscheidung.

## Download

Sodata zeigt einen Link. APISIX verarbeitet die Identität und fragt `/internal/authorization/check` bei Admin per `forward-auth`. Admin prüft Pfad, Publikationszustand und bei restricted das aktuelle Leserecht. Das Gateway erreicht den internen Origin bei positiver Prüfung. rclone liest das gebundene Objekt aus dem privaten Bucket. Bei Ausfall des Autorisierungsdienstes bleibt der Origin gesperrt. Der konfigurierte Fehlerstatus und fachliche Ablehnungen sind getrennte Fälle.

Die Katalogrolle `di_public` liest ausschliesslich die freigegebenen Sichten. Die technische ClickHouse-Verbindung von Superset ist von diesem Downloadrechtepfad getrennt. Der aktuelle Quellenstand weist für diesen Analytics-Zugang keine persönliche Projektion der PostgreSQL-Fachrechte aus. [Quellenbindungen](../contracts/source-bindings.json)
