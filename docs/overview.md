# System und Abläufe

## Systemgrenze

Datenliefernde bedienen das Jenkins-Plugin, Katalognutzende suchen und laden Daten, Berechtigende pflegen den Katalog und entscheiden über Freigaben. Technische Datennutzende arbeiten mit Superset oder über den lokalen SQL-Zugang. Die Übersicht beschreibt das gemeinsam gestartete lokale Compose-System.

APISIX bündelt die Browserpfade für Katalog, Management, Jenkins und Downloads. Admin führt Management, fachliche Autorisierung, Anlieferungssteuerung, Fachannahme und Projektion im gleichen Java-Prozess aus. Sodata liest freigegebene PostgreSQL-Sichten und erzeugt Katalogseiten mit Downloadlinks. Ein interner rclone-Origin liefert freigegebene Dateien aus Garage.

## Datenhaltung und Ausführung

- PostgreSQL 16 mit PostGIS hält Management-, Keycloak- und Superset-Daten in getrennten logischen Datenbanken. Managementrollen trennen Fachwrites, Autorisierung, öffentlichen Katalog und Auditlesen.
- Garage hält die Dateien im privaten Bucket `ch.so.daten`. Der rclone-Origin verwendet Reader-Zugangsdaten. Veröffentlichungsstatus und Leserecht werden am fachlichen Datensatz entschieden.
- ClickHouse enthält Kandidaten und abgeleitete SQL-Sichten. Superset nutzt eine technisch konfigurierte Verbindung und speichert seine Metadaten in PostgreSQL.
- Jenkins führt das Plugin und den GRETL-Runner aus. Plugin und Runner sind Verantwortlichkeiten im Jenkins-Kontext. Compose betreibt dafür einen Dienst.

## CSV-Anlieferung

Das Plugin fragt Admin nach dem aktuellen Anlieferungsrecht und einer Upload-Erlaubnis. Es speichert die Eingabe im privaten Jenkins-Spool und übermittelt einen gebundenen Beleg mit Referenz, Hash und Grösse. Admin verwaltet Submission, Dispatch, Claim und Ausführungsplan. Upload- und Jobparameter sind Eingaben in diesen Vertrag.

Der Runner validiert die Eingabe, erzeugt den Snapshot, erstellt Kandidatenausgaben und prüft Exporte durch Rücklesen. Admin gleicht den gemeldeten Abschluss mit den gebundenen Plan- und Checkpointdaten ab. Vor der Annahme prüft Admin das ursprüngliche Recht und die Basisversion erneut. Bei Entzug oder veralteter Basis bleibt der bisherige Stand gültig. Eine identische gebundene Wiederholung liefert die bereits erfasste Annahme. Abweichende Resultate lösen einen Konflikt aus.

Der PostgreSQL-Fachcommit setzt Submission und Execution auf `COMMITTED` und meldet die ausstehende SQL-Aktualisierung. Der Reconciler leitet den Sollstand aus dem aktuellen Katalog ab, veröffentlicht und prüft die ClickHouse-Sicht und quittiert erst danach den Projektionsstand in PostgreSQL. Bis zur Quittierung bleibt Arbeit ausstehend. [Quellenbindungen](../contracts/source-bindings.json)
