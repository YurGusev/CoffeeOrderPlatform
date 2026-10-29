# Предложение: точная матрица grants для G08

**Статус:** предложение для review; конфигурация, схема, миграции и код пока не менялись. Реализация требует отдельного согласования изменения формата role map.

## Основание

Статическая сверка выполнена для candidate `3c2d07bae4274183504008b304d53252a7cb501d`. Её ограниченный отчёт — `/home/yurgusev/.cache/coffee-issue13/resume-20261025T082058Z/orders-grant-static-diff.json`, SHA-256 `2ea7405f665734604f78b0a747d75c39dd84cd3417bb6ed426bf727faec2a3ea`. В отчёте сопоставлены role map, миграции всех пяти владельцев и runtime SQL callers; parser ограничения описаны в самом отчёте. Это статический разбор, не свидетельство фактических ACL живой БД.

`scripts/db-bootstrap.mjs` сейчас рендерит каждую запись `tables` как табличный `GRANT` (`conditionalGrantSql`, строки 476–508) и повторяет его при `ensureDatabaseObjects` (строки 537–568). Поэтому при повторной инициализации `UPDATE` из role map может расширить уже ограниченный column-level доступ до всей таблицы. Каноническая миграция уже ограничивает четыре таких grants:

| Роль | Таблица | Разрешённые UPDATE-колонки | Authority |
|---|---|---|---|
| `coffee_catalog_activate_rw` | `catalog.supplier_snapshots` | `state, failure_code, declared_batch_count, declared_product_count, declared_variant_count, declared_offer_count, content_hash, received_at` | `apps/catalog-service/migrations/0007_catalog_grants.sql` |
| `coffee_catalog_activate_rw` | `catalog.source_identities` | `last_seen_snapshot_ref, state` | `apps/catalog-service/migrations/0007_catalog_grants.sql` |
| `coffee_orders_service_rw` | `orders.orders` | `status, version, customer_ref, customer_version, customer_display_name, customer_state, customer_state_proof_hash, currency, confirmed_at, updated_at, last_modified_by_actor_ref` | `apps/orders-service/migrations/0018_guard_order_card_projection.sql` |
| `coffee_orders_convergence_rw` | `orders.convergence_work` | `dirty, next_attempt_at, updated_at` | `apps/orders-service/migrations/0016_create_aroma_work_schedules.sql` |

`coffee_catalog_import_rw` сохраняет отдельный табличный `UPDATE` на `catalog.supplier_snapshots`: это другой writer и другой caller, не часть activation-ограничения.

## Рекомендуемое решение

1. Перевести `config/database-role-map.json` и его schema целиком на `schemaVersion: 2`, без dual-mode чтения v1/v2. Новая схема содержит закрытое `columnUpdates`-описание ровно для четырёх пар выше; это небольшой форматный контракт, а не универсальная модель ACL. Для этих пар поле `tables` продолжает указывать разрешённый класс `UPDATE`, но renderer выдаёт только перечисленный column grant и гарантирует отсутствие табличного `UPDATE`. Остальные права рендерятся как прежде.
2. Для повторяемого bootstrap на этих четырёх парах устранять или отклонять лишние существующие column-level `UPDATE` grants: одного `REVOKE UPDATE ON TABLE` недостаточно, потому что он не удаляет отдельные column grants. Renderer должен сверять фактический список column grants с точным allowlist; неизвестный или лишний grant отозвать адресно и перепроверить либо завершиться fail-closed до продолжения. Затем выдать точный `UPDATE (columns...)` и удостовериться, что табличного `UPDATE` нет. Для прочих таблиц и ролей сохранить принятые SQL-права.
3. Синхронизировать role map с реальными именами таблиц и миграционными grants. Для Orders целевая матрица ниже задаёт privilege-классы; `UPDATE` на двух отмеченных таблицах означает исключительно столбцы из `columnUpdates`, не табличный grant.
4. Удалить только неиспользуемый runtime `DELETE` на `orders.orders`: текущий Orders service не удаляет parent order; его `DELETE` относится к `orders.order_items`. Добавить owner migration `apps/orders-service/migrations/0024_restrict_runtime_order_delete.sql` с одним сужающим `REVOKE DELETE ON TABLE orders.orders FROM coffee_orders_service_rw`. Не переписывать уже принятые SQL-файлы.
5. Уточнить G08 grant oracle: сравнивать табличные права отдельно от column-level прав. Для этих четырёх пар требовать точный набор колонок и отсутствие табличного `UPDATE`; union привилегий по типу недостаточен. Для остальных пар сравнивать точную матрицу role map с применёнными grants.

### Целевая Orders-матрица

Матрица перечисляет право, которое должно быть доступно роли после миграций. У `orders.orders` и `orders.convergence_work` `UPDATE` ограничен колонками из таблицы выше.

| Роль | Таблица | Права |
|---|---|---|
| `coffee_orders_service_rw` | `orders` | `SELECT, INSERT, UPDATE` |
|  | `order_items` | `SELECT, INSERT, UPDATE, DELETE` |
|  | `order_history` | `SELECT, INSERT` |
|  | `order_desired_contributions` | `SELECT, INSERT` |
|  | `order_desired_contribution_lines` | `SELECT, INSERT` |
|  | `idempotency_records` | `SELECT, INSERT, UPDATE` |
|  | `outbox_messages` | `SELECT, INSERT, UPDATE` |
|  | `order_aroma_projections` | `SELECT` |
| `coffee_orders_prepare_rw` | `orders`, `order_items`, `order_desired_contributions`, `order_desired_contribution_lines`, `order_history`, `order_aroma_projections`, `cart_observed_revisions`, `cart_observed_lines`, `convergence_attempts`, `convergence_leases`, `mutation_reservations` | `SELECT` |
|  | `catalog_mapping_projection`, `cart_desired_revisions`, `inbox_messages`, `outbox_messages` | `SELECT, INSERT, UPDATE` |
|  | `cart_desired_lines`, `cart_desired_blockers`, `cart_desired_order_facts`, `inbox_quarantine`, `order_aroma_projection_history` | `SELECT, INSERT` |
|  | `convergence_work` | `SELECT, INSERT, UPDATE` |
| `coffee_orders_observer_rw` | `cart_desired_revisions`, `cart_desired_lines`, `cart_desired_order_facts`, `order_aroma_projections` | `SELECT` |
|  | `cart_observed_revisions`, `inbox_messages`, `observation_schedule`, `outbox_messages` | `SELECT, INSERT, UPDATE` |
|  | `cart_observed_lines`, `inbox_quarantine` | `SELECT, INSERT` |
| `coffee_orders_convergence_rw` | `cart_desired_revisions`, `cart_desired_lines`, `cart_desired_blockers`, `cart_desired_order_facts`, `cart_observed_lines`, `catalog_mapping_projection`, `order_aroma_projections` | `SELECT` |
|  | `cart_observed_revisions`, `convergence_attempts`, `convergence_leases`, `inbox_messages`, `mutation_reservations`, `outbox_messages` | `SELECT, INSERT, UPDATE` |
|  | `inbox_quarantine` | `SELECT, INSERT` |
|  | `convergence_work` | `SELECT, UPDATE` |

`orders.orders` для `coffee_orders_service_rw` после `0024` не имеет `DELETE`. Роль `coffee_orders_prepare_rw` читает `order_desired_contribution_lines`; это имя фактической append-only таблицы вместо отсутствующей в migrations `order_desired_lines`. `coffee_catalog_import_rw` сохраняет полное табличное право `UPDATE` на `supplier_snapshots` отдельно от ограниченного activation grant.

Сводка сверки насчитала 34 миграционных privilege-типа, отсутствующих в текущем map, и 9 привилегий map без эффективного migration grant. Это не означает, что нужно механически добавить 34 права: целевая Orders-матрица включает caller-backed существующие права; фантом `order_desired_lines`, лишний append-only `UPDATE` и неиспользуемый parent-order `DELETE` устранены. У `DELETE orders` будет отдельная сужающая миграция; остальные принятые migration grants сохраняются. Четыре column-scoped `UPDATE` проверяются отдельно, а не считаются эквивалентом table `UPDATE`.

## Файлы и проверки при отдельном разрешении реализации

- `config/database-role-map.json`, `config/database-role-map.schema.json`, `scripts/db-bootstrap.mjs`: единственный формат `schemaVersion: 2`, его schema и узкий renderer для четырёх пар. `validateRoleMap` и прямая проверка role-map version в `tools/config-bootstrap/index.mjs` должны принимать единственный v2; все callers общего валидатора должны принять v2: `scripts/db-smoke.mjs`, `verification/launch/v1/run.mjs`, `verification/launch/v1/scenarios/migrations.mjs` и `verification/launch/v1/scenarios/backup-restore.mjs`. Прямые consumers role map также требуют согласования: `scripts/db-live-proof.mjs` (permission probes для column-scoped UPDATE), `verification/launch/v1/scenarios/backup-restore-recovery.mjs`, `scripts/catalog-copy-live-proof.mjs` и тестовые readers `tests/config/platform-config.test.mjs`, `tests/authority/test_launch_authority.py`, `tests/catalog-pipeline/security-live.test.mjs`.
- `apps/orders-service/migrations/0024_restrict_runtime_order_delete.sql`: только revoke неиспользуемого parent-order `DELETE`; миграционные файлы до `0024` неизменны.
- `verification/launch/v1/scenarios/migrations.mjs`: ACL oracle по раздельным table/column privilege источникам и точным колонкам.
- Существующие `tests/database/db-bootstrap.test.mjs` и G08 migration tests: повторный bootstrap не расширяет scoped grants; неправильные или лишние column grants и table-level `UPDATE` отклоняются. Один тест добавляется в существующий suite, без расширения G04 inventory. Orders migration count изменится `23 → 24`; сумма всех текущих миграций — `46 → 47`; принятый исторический prefix остаётся `27` (Orders prefix `6`), остальные owners и их миграции не меняются.
- Runtime callers, прочитанные для сверки, остаются без изменений: `apps/orders-service/src/infrastructure/database/order-store.ts`, `apps/orders-aroma-preparation/src/infrastructure/preparation-store.ts`, `apps/aroma-convergence/src/infrastructure/convergence-store.ts`, `apps/aroma-observer/src/infrastructure/observation-store.ts`, `apps/catalog-activation-worker/src/infrastructure/activation-store.ts` и `apps/catalog-supplier-sync/src/infrastructure/catalog-import-store.ts`.

Проверки после реализации: config/schema validation, целевой DB-bootstrap test, G08 clean и forward migration suites, затем narrow type-aware lint/format. Настоящие PostgreSQL clean/forward проверки остаются обязательным gate и не заменяются статическими тестами. До отдельного разрешения не менять role-map schema, owner migrations, bootstrap renderer, ACL oracle или suite inventory.
