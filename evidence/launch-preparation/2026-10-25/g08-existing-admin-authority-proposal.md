# G08: существующая admin identity и условная синхронизация credential

Статус: конкретное дополнительное предложение владельцу; не разрешает новую мутацию.
Основа: ранее одобренный `g08-bootstrap-authority-proposal.md` остаётся в силе
для пяти migrator credentials и CREATE-only transaction ровно 15 отсутствующих ролей.

## Установленные факты

Actual read-only G08 probe на clean `9e20f3603e5a59826af49fa24ebaec6b49339740`
остановился при connect: категория `authentication`, SQLSTATE `28P01`. Helper
ошибочно предполагает LOGIN `postgres`. Несекретная конфигурация уже работающего
контейнера `coffee_postgres` указывает `POSTGRES_USER=coffeeuser`; password value
не читался и не выводился.

Свежий запрос 25 октября 2026, 09:45:56 UTC выполнил только `BEGIN TRANSACTION
READ ONLY`, system identity/allowlisted role inventory SELECT и `ROLLBACK` в
служебной DB `postgres` через local socket уже работающего сервера:

- PostgreSQL `17.11`, system identifier `7613370342949990434`;
- current user `coffeeuser`, superuser=true, current database `postgres`;
- все 15 canonical ролей отсутствуют.

Это диагностическая metadata, не TCP/SOPS admission и не G08 PASS. Business/legacy
DB `coffeeorderdb` и `coffeeorder_staging` не открывались. Canonical encrypted
bundle и роли не менялись. Текущий encrypted-file SHA-256:
`ba06572e426e3d0d3dba56e1e54a095bf6784ecb438e292c08f740a71743204d`.

Источник возможного credential ограничен текущими immutable identities:

- container ID `267958ce276e65d96c4a5d2cfc4541de35f9785de3dd15c04c34798cf7b1c85f`;
- image ID `sha256:1bea307dfb3ee30541a7acf7de14b58bcd6948da98e5d31a04c627c4d35ec64b`;
- network `coffee_network`.

## Точный предлагаемый scope

1. В единственный `config/platform.yaml` добавить несекретный
   `postgres.bootstrapUsername: coffeeuser`; отразить его в существующих schema,
   parser/types и тестах. Только G08 admin/probe использует это значение вместо
   ошибочного hardcoded `postgres`. Runtime claims/credentials, G16/G17 отдельные
   scoped targets и существующие роли не менять. Endpoint остаётся строго
   `coffee_postgres:5432`, non-production, database `postgres`.
2. Владелец подтверждает указанные PostgreSQL 17.11/system identifier как target.
   После нового clean candidate/context trusted config-bootstrap сначала пробует
   существующий SOPS `bootstrap.postgresAdminPassword` с настроенным `coffeeuser`.
   Fresh TCP probe обязан подтвердить тот же server identity, superuser и все
   15 отсутствующих ролей. При успехе admin secret вообще не переписывается.
3. Только если с правильным username получен именно `28P01`, разрешить trusted
   config-bootstrap прочитать в RAM только `POSTGRES_PASSWORD` из точного текущего
   контейнера `coffee_postgres` (immutable container/image/network identities
   фиксируются и повторно сверяются). До SOPS write этим credential выполнить
   read-only TCP probe того же endpoint/DB/user и потребовать тот же approved
   server ID/version и all-15-absent. Если key отсутствует, credential не подходит,
   identity изменилась или есть хотя бы одна роль — STOP без SOPS write/DDL.
4. При подтверждённом credential разрешить заменить только значение
   `environments.development.bootstrap.postgresAdminPassword` в canonical SOPS.
   Пароль роли на PostgreSQL не меняется. Использовать уже проверенные schema,
   encrypted leaves/recipients, in-memory decrypt-roundtrip, full equality всех
   остальных plaintext fields, encrypted temp, SHA/dev/inode CAS и atomic rename.
   Plaintext не писать на диск, в argv/env/logs/artifacts; password не возвращать
   из trusted bootstrap. Из Docker metadata наружу выходят только несекретные
   identity fingerprints и конечный outcome. Другие env variables не читаются.
5. После возможного encrypted-file change — новый clean candidate/context.
   Затем только ранее одобренная preparation: свежий identity/all-absent probe,
   пять новых migrator passwords и CREATE-only 15 ролей в одной transaction.
   При conflict/unknown COMMIT прежний STOP/no-repair/no-retry сохраняется.

## Проверка до live

Tests на configured username, отказ от runtime/admin mismatch и production target;
current-SOPS success без admin rewrite; missing/wrong source credential или
changed container/server identity без write; invalid ciphertext/round-trip и
concurrent bundle replacement сохраняют исходный файл. Никаких ALTER ROLE,
password rotation, DROP/repair, provider mutations или business/legacy DB access.

## Почему требуется отдельное решение

Ранее разрешение охватывает новый блок пяти migrator credentials и 15 новых ролей.
Оно не утверждало admin LOGIN identity в конфигурации или чтение existing legacy
container credential с возможной синхронизацией одного SOPS admin field. Эти
дополнительные границы требуют решения по AGENTS.md: config trust и secret data
source. До решения выполняется только read-only анализ; текущий G12 продолжается.
