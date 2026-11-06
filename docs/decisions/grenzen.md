# Entscheidungen und Herkunft

- **Freigegebene Workspace-Entscheidung**. Das Architekturrepositorium verwendet das Inventar des Workspace-Commits. Die Produktrepositorien behalten ihre eigenen Git-Grenzen.
- **Bestehender Storagevertrag**. Ein privater Bucket und eine zentrale fachliche Autorisierung halten Speicherzugang und Dataset-Recht getrennt.
- **Beobachtete Implementierung**. Die fachliche Annahme in PostgreSQL und die nachfolgende bestätigte ClickHouse-Projektion haben getrennte Zustände.
- **Freigegebene Dokumentationsentscheidung**. Das Modell beschreibt die Struktur. Quellenlock, Prüfdeckung und Laufzeitbelege beschreiben den Nachweis eines konkreten Stands.
