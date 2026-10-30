# Карта фич бэкенда

Каталог `apps/` содержит шестнадцать сервисов этой карты и отдельно `web`.
`web` сюда не входит. Его карта лежит в [verify-web](../verify-web/features/README.md).

Имена сверены со списком каталогов `apps/`: `api-internal`, `api-public`,
`aroma-convergence`, `aroma-gateway`, `aroma-observer`, `catalog-activation-worker`,
`catalog-service`, `catalog-supplier-sync`, `customer-service`, `edge-gateway`,
`edge-nginx`, `orders-aroma-preparation`, `orders-service`, `pricing-service`,
`realtime-gateway`, `tasty-gateway`.

`tasty-gateway` есть в `apps/` и отсутствует в `config/service-catalog.json`.
Остальные пятнадцать имён есть в этом каталоге. `edge-nginx` и `tasty-gateway`
не вызывают `startConfiguredRuntime`.

Строка таблицы считается один раз. Статус один.

- `проверяется живым навыком customer-slice-verify` значит, что
  `node tools/grokverify-customer.mjs` вызывает эту операцию.
- `только unit/integration тесты` значит, что живого навыка нет, а тест в
  указанном пути есть.
- `не покрыто` значит, что вызова этой операции в `tests/` не найдено.

| | Живой навык | Только тесты | Не покрыто |
|---|---:|---:|---:|
| Операции | 3 | 118 | 12 |
| События | 0 | 16 | 0 |

Три живые операции принадлежат `customer-service`: `POST /api/client-v1/customers`,
`GET /api/client-v1/customers` и `GET /health/ready`. Двенадцать непокрытых
операций принадлежат `edge-nginx`. Событие без теста не найдено.

Файлы `*-live.test.mjs`, которым нужен `COFFEE_DB_LIVE_PROOF=1`, обычный
`pnpm test` пропускает. Строка всё равно относится к тестам: сценарий лежит в
указанном файле.
`CatalogSnapshotActivated.v1` публикуется и в `contracts/manifest.yaml` имеет
пустой `consumers`. Подписчика в `apps/` нет.

## Сервисы

| Сервис | Файл |
|---|---|
| api-internal | [features/api-internal.md](features/api-internal.md) |
| api-public | [features/api-public.md](features/api-public.md) |
| aroma-convergence | [features/aroma-convergence.md](features/aroma-convergence.md) |
| aroma-gateway | [features/aroma-gateway.md](features/aroma-gateway.md) |
| aroma-observer | [features/aroma-observer.md](features/aroma-observer.md) |
| catalog-activation-worker | [features/catalog-activation-worker.md](features/catalog-activation-worker.md) |
| catalog-service | [features/catalog-service.md](features/catalog-service.md) |
| catalog-supplier-sync | [features/catalog-supplier-sync.md](features/catalog-supplier-sync.md) |
| customer-service | [features/customer-service.md](features/customer-service.md) |
| edge-gateway | [features/edge-gateway.md](features/edge-gateway.md) |
| edge-nginx | [features/edge-nginx.md](features/edge-nginx.md) |
| orders-aroma-preparation | [features/orders-aroma-preparation.md](features/orders-aroma-preparation.md) |
| orders-service | [features/orders-service.md](features/orders-service.md) |
| pricing-service | [features/pricing-service.md](features/pricing-service.md) |
| realtime-gateway | [features/realtime-gateway.md](features/realtime-gateway.md) |
| tasty-gateway | [features/tasty-gateway.md](features/tasty-gateway.md) |

## Живые навыки срезов

Сейчас живой навык бэкенда один: [customer-slice-verify](../customer-slice-verify/SKILL.md).
Следующие срезы предполагаются отдельными PR. Каждый такой PR обновляет строки
своего сервиса в этой карте.

| Будущий срез | Файлы карты |
|---|---|
| orders | `features/orders-service.md`, `features/orders-aroma-preparation.md` |
| catalog | `features/catalog-service.md`, `features/catalog-supplier-sync.md`, `features/catalog-activation-worker.md` |
| pricing | `features/pricing-service.md` |
| aroma-gateway | `features/aroma-gateway.md` |
| edge-gateway | `features/edge-gateway.md`; nginx, если срез его поднимает, `features/edge-nginx.md` |
| realtime-gateway | `features/realtime-gateway.md` |
| tasty-gateway | `features/tasty-gateway.md` |
| воркеры | `features/catalog-activation-worker.md`, `features/catalog-supplier-sync.md`, `features/orders-aroma-preparation.md`, `features/aroma-observer.md`, `features/aroma-convergence.md` |

Навык среза ставит статус `проверяется живым навыком <имя>` только тем строкам,
которые его команда действительно вызывает. Остальные строки он не помечает пройденными.

## Как держать карту

Периодически сверять карту навыком pstack `maintain-verification-skill`.
Единица сверки здесь файл `features/<service>.md`. Для каждой строки нужны путь
в коде и либо тест, либо команда живого навыка. Если код ушёл, а карта нет,
правится карта. Если операция в коде сломана, это отдельная задача. Этот
просмотр приложение не чинит.

Предметные навыки в `.agents/skills/` не дублировать. Ссылки на них лежат в
[SKILL.md](SKILL.md).

## Находки

Это расхождения записей и кода. В этой карте они не исправляются.

`packages/contracts/edge-v1/src/index.ts` указывает source
`contracts/openapi/client-v1.yaml` и реэкспортирует generated client-v1.
Маршруты `apps/edge-gateway/src/routes.ts` совпадают с
`contracts/openapi/edge-auth-v1.yaml`. Сервис пакет `contracts-edge-v1` не импортирует.

`config/platform.yaml` включает `coffee.realtime.invalidate.v1` в
`aroma-convergence.kafka.producers`. `apps/aroma-convergence` ставит в outbox
только `coffee.aroma.cart.events.v1`. `contracts/manifest.yaml` не называет
`aroma-convergence` производителем `RealtimeInvalidated.v1`.

`contracts/manifest.yaml` называет `orders-service` производителем
`AromaConvergenceRequested.v1` и `RealtimeInvalidated.v1`. Строку outbox с этими
типами создаёт `apps/orders-aroma-preparation/src/infrastructure/preparation-store.ts`.
`apps/orders-service` создаёт `OrderConfirmed.v1` и
`OrderReconciliationRequested.v1`. Релей `orders-service` всё равно берёт
allowlist, в котором есть command и realtime топики.

`config/service-catalog.json` у runtime `edge-gateway` перечисляет входящие
`GET /`, `GET /assets/**`, `ANY /api/client-v1/**`, `GET /events`,
`GET /health/live`. Эти location собраны в `apps/edge-nginx/generated/nginx.conf`.
`apps/edge-gateway/src/routes.ts` регистрирует `/auth/login`, `/auth/callback`,
`/auth/session`, `/auth/logout` и `/_edge/authorize`.
