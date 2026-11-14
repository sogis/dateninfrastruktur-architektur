# System und Abläufe

APISIX verbindet die Browserpfade für Katalog, Management, Jenkins und
Downloads. Admin verwaltet den Katalog, Fachrechte und CSV-Submissions
in einem Java-Prozess. Sodata liest die PostgreSQL-Sichten
`di_api_public` mit `di_public`. Für jeden Download holt APISIX beim
Admin einen aktuellen Fachentscheid ein und leitet nur freigegebene
Anfragen an den internen rclone-Origin mit privatem Garage-Zugang weiter. Bei einem
Admin-Ausfall verweigert APISIX Downloads mit HTTP 503. Positive und
negative DNS-Antworten für Compose-Dienste werden zwei Sekunden gecacht.

PostgreSQL 16/PostGIS betreibt getrennte Datenbanken für Management,
Keycloak und Superset. ili2pg legt die vier INTERLIS-Modelle in
`di_management` sowie die öffentlichen Sichten über sein PostScript an.
Cayenne schreibt Fachobjekte mit stabilen TIDs in die vorhandenen
INTERLIS-Baskets. Das Organization-Modell begrenzt die Text-TIDs von
Office und ContactPoint auf 200 Zeichen. Setup und Admin-Start prüfen
lesend, dass beide PostgreSQL-Spalten als `varchar(200)` angelegt sind.

Die interne Delivery-API trennt Benutzer- und Service-Identität.
Beim Start bindet Admin Schema und Basisversion. Beim Abschluss prüft
Admin den vorbereiteten Kandidaten sowie die aktuellen Rechte und
vergleicht die Basisversion unter einer Zeilensperre. Version,
Distribution und Annahme werden in derselben Transaktion gespeichert.
Die alte Jenkins-Uploadroute ist gesperrt. Der isolierte Durchstich
verwendet vorbereitete Testartefakte. Superset nutzt die technische
ClickHouse-Verbindung getrennt von diesem Ablauf.

[Quellenbindungen](../contracts/source-bindings.json)
