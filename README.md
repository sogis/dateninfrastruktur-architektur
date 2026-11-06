# Dateninfrastruktur · lokale Ist-Architektur

Sieben LikeC4-Sichten zeigen Systemgrenze, technische Dienste, Admin, CSV-Anlieferung, Fachrechte, Downloads und das lokale Deployment. Das Repository pinnt den untersuchten Workspace und die Produktstände in [sources.lock.json](sources.lock.json). Die fachliche Übersicht wird separat gepflegt. [Fachliches Diagramm](https://github.com/sogis/dateninfrastruktur-diagramm)

Mit Node 22.23.1 und npm 11.18.0 aus diesem Repository ausführen.

```sh
npm ci
npm run validate
npm test
npm run check
npm run build
python3 -m http.server --bind 127.0.0.1 4173 --directory dist
```

Die lokale Übersicht ist unter [localhost:4173](http://127.0.0.1:4173/) erreichbar. Für die Browserprüfung einmal `npm run browser:install` und dann `npm run test:browser` ausführen.

- [System und Abläufe](docs/overview.md)
- [Identität, Rechte und Vertrauensgrenzen](docs/security.md)
- [Lokaler Betrieb und Prüfung](docs/operation-and-validation.md)

Der angezeigte Quellenstand gilt für den lokalen Compose-Stack. Der Build weist ausstehende Laufzeitnachweise und den fehlenden Remotevergleich aus. Die LikeC4-Version ist im Paketlock festgeschrieben. [LikeC4-CLI](https://likec4.dev/tooling/cli/)
