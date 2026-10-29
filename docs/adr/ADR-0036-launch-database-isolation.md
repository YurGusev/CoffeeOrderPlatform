# ADR-0036: имена verification DB из доверенной identity запуска

Статус: решение принято владельцем 24 октября 2026; реализация проверяется в #13.
Основание: явное разрешение «Разрешаю предложенную изоляцию DB» к
[предложению](../../evidence/launch-preparation/2026-10-24/database-namespace-authority-proposal.md).
Отдельная граница G17 разрешена точной формулировкой «Разрешаю предложенный G17 Unix socket» ([историческое предложение](../../evidence/launch-preparation/2026-10-24/g17-native-socket-authority-proposal.md)):
private endpoint допустим только в non-production config с включённой database isolation,
после проверки readonly run/SHA/config context и G00 server identity. Обычные runtime
не подключаются к этому endpoint; canonical `coffee_postgres` сохраняется.

## Контекст

Runner создаёт run-id из текущего UTC timestamp и SHA уже существующего
candidate. Эти значения нельзя заранее включить в имена DB того же commit.
Буквальное требование будущих имён в committed YAML делало G00 невыполнимым.

## Решение

Единственный `config/platform.yaml` сохраняет canonical `coffee_platform_<owner>`
и явную policy `verification.databaseIsolation.enabled`, выключенную по умолчанию.
Только в verification candidate разрешается committed `enabled: true`.
Production запрещён. Роли, schemas, grants, secret refs и бюджеты не меняются.

Runner записывает metadata run-id, полный candidate SHA и SHA-256 базовых
байтов config в read-only context. `COFFEE_LAUNCH_CONTEXT_FILE` — только
абсолютный locator этого regular файла; symlink, writable файл и oversized
context отклоняются до подключения к DB. Это не источник DB names, credentials
или иных настроек. Compose передаёт его readonly bind только включённому
verification candidate. Наличие context при выключенной policy и включённая
policy без context завершают runtime ошибкой.

Общий helper `packages/platform-config/src/launch-database-target.ts` проверяет
run/SHA и canonical owner map, затем вычисляет:

```text
normalized = lowercase(run-id), единственный '-' заменён на '_'
database = coffee_verify_<normalized>_<owner>
owner ∈ {customer, catalog, pricing, orders, integration}
```

Полученное имя должно совпадать с `allowedDatabase`. Произвольные names/prefixes
из context не используются. Канонические ownership/role manifests проверяются
до проекции; в памяти меняются только имена DB и соответствующие runtime claims.
Обычный запуск сохраняет прежние canonical targets.

G00 проверяет план всех десяти DB runtime и пяти владельцев до создания ресурсов.
Runtime сверяет фактические байты config с base digest. Для G18 допускается
ровно исключение [ADR-0035](ADR-0035-launch-rollback-config-lineage.md): только
`aroma-convergence` в состоянии D с `mutationsEnabled=false` может подтвердить
base digest обратной заменой единственного literal flag. Остальные байты обязаны
совпасть. Git validator отдельно доказывает B→D→R; дополнительные hashes/overlays
не принимаются.

## Проверка и границы

Обязательны отрицательные проверки policy/context/production/SHA/owner/path и
фактический runtime proof пяти вычисленных DB с cleanup только собственных
ресурсов. Static и mock tests не доказывают этот runtime результат.
Standalone G18 на disposable PostgreSQL не заменяет full launch и не отменяет
требование G13 использовать внешний PostgreSQL без создания PostgreSQL service.
Исторические FAIL и их manifests сохраняются. Этот ADR не разрешает deployment,
GitHub publication, provider mutation или запись в legacy/production DB.
