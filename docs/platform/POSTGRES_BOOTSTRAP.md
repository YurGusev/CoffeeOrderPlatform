# Bootstrap PostgreSQL-платформы

`config-bootstrap` — единственный caller административного bootstrap. Он создаёт
только пять новых логических БД, перечисленных в
`config/database-ownership.json`, и никогда не подключается к legacy
`coffeeorderdb` или `coffeeorder_staging` как к target.

## Безопасный порядок запуска

1. Trusted bootstrap расшифровывает SOPS secret bundle в памяти и получает
   `rolePasswords` для migrator/app-ролей. Пароли не передаются через Git,
   логи или постоянный файл.
2. Оператор задаёт полный `COFFEE_DB_ADMIN_URL` и точный
   `COFFEE_DB_EXPECTED_SERVER_IDENTITY`. Подстановки, wildcard и неизвестный
   `system_identifier` отклоняются.
3. Bootstrap проверяет superuser, PostgreSQL `17.11`, не-legacy maintenance
   database и только после этого захватывает advisory lock.
4. Для каждой БД он создаёт migrator-role и app-role с `NOSUPERUSER`,
   `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`, отзывает `PUBLIC` database/schema
   privileges и выдаёт только `CONNECT`, `TEMPORARY`, `USAGE` и allowlist из
   `config/database-role-map.json`.
5. Schema создаётся с владельцем migrator-role. Если существующая БД или schema
   принадлежат другой роли, bootstrap завершается ошибкой и ничего не
   переназначает.

Команда без флага `--execute` ничего не подключает. Для просмотра безопасного
плана:

```text
node scripts/db-bootstrap.mjs --plan
```

Live `--execute` предназначен только для trusted init job с `pg` и decrypted
secret bundle. Переменная `COFFEE_DB_ROLE_PASSWORDS_JSON` оставлена только для
локального ephemeral запуска; production caller должен передавать секреты в
`bootstrapDatabases()` из памяти после SOPS decrypt.

Повторный запуск безопасен: существующая БД принимается только при совпадении
владельца migrator-role, schema — только при совпадении владельца; операции
ролей, revoke/grant и search path задаются повторно тем же декларативным планом.

## DB smoke

`node scripts/db-smoke.mjs --plan` выводит 10 own-write и 40
foreign-connect-denied cases. Live режим требует одновременно
`COFFEE_DB_SMOKE_ENABLED=true`, короткий `COFFEE_DB_SMOKE_RUN_ID` и точный
prefix `coffee_verify_<run-id>_`. Поэтому smoke не может случайно записать в
пять постоянных `coffee_platform_*` БД. В собственной БД используется только
`TEMP TABLE` внутри транзакции с `ROLLBACK`; foreign connection обязан получить
PostgreSQL `42501 permission denied`.

Статические проверки не заявляют, что GRANT применены на сервере. Для этого
нужен отдельный запуск smoke на заранее созданном изолированном verification
target и с сохранённым результатом проверки.

## Проверка подготовленных ролей перед миграциями

В `test:migrations:clean` trusted bootstrap сверяет утверждённый
`system_identifier`, точный набор и атрибуты 15 canonical ролей. Затем он
подключается каждой ролью к maintenance database `postgres` и подтверждает
password authentication текущими SOPS credentials. Проверки PostgreSQL,
контекста запуска, конфигурации и encrypted bundle повторяются перед возвратом
результата. Роли, БД и SOPS при этом не изменяются.

После успешной проверки `migrations` сохраняет run-bound proof со стадией
`roles-verified`, `createdCount: 0` и `transaction: "read-only"`. Он подтверждает
текущее состояние, а не прошлое создание ролей. Исторический `roles-created`
с `createdCount: 15` и `transaction: "committed"` сохраняет прежние проверки.
Оба вида proof связываются с ciphertext SHA-256; `roles-verified` дополнительно
требует точного совпадения run, candidate и configuration текущего запуска.
Ошибка аттестации не создаёт proof и не разрешает запуск миграций.
