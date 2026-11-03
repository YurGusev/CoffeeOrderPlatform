# Контракт HTTP API

Исполнимые нормативные definitions находятся в
`contracts/openapi/client-v1.yaml` и `contracts/openapi/internal-v1.yaml`.
Types-only artifacts материализуются в `packages/generated/{client,internal}-v1`;
handlers и transport adapters остаются за владельцами downstream issues.

## Клиентские маршруты первого запуска

```http
POST /api/client-v1/customers
GET  /api/client-v1/customers?query=
GET  /api/client-v1/catalog/products?query=&availability=
POST /api/client-v1/pricing/quotes
POST /api/client-v1/pricing/catalog-preview
POST /api/client-v1/orders/drafts
PUT  /api/client-v1/orders/{orderRef}/items/{itemRef}
DELETE /api/client-v1/orders/{orderRef}/items/{itemRef}
POST /api/client-v1/orders/{orderRef}/commands/confirm
POST /api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation
GET  /api/client-v1/orders/{orderRef}
GET  /events
```

Поиск Catalog маршрутизируется через `api-public` в `catalog-service`: API-root
проверяет actor/delegation и контракт, а owner читает только active projection
под `coffee_catalog_api_ro`. Неверный подписанный cursor возвращает
`400 INVALID_CURSOR`; отсутствие active revision — `503 CATALOG_SNAPSHOT_INCOMPLETE`.
Отказ транспорта Catalog или БД — `503 CATALOG_UNAVAILABLE`, не ложный incomplete snapshot.
Private Pricing input доступен только через `api-internal` для подписанного
`pricing-service`, не публикуется через `client-v1`.

## Требования к командам

Команды, изменяющие состояние, требуют:

- аутентифицированного actor, определённого сервером;
- `Idempotency-Key`;
- ожидаемой версии владельца в виде decimal string;
- схем request и response;
- контекста correlation и trace;
- стабильного кода Problem Details.

`confirm` receives no provider identifier, URL, credential or authoritative
price from the browser. It validates the persisted quote reference/hash and
current OrderVersion locally.

Для восстановления после потерянного ответа семь client-v1 commands поддерживают
bodyless `Idempotency-Replay-Only: true` с прежним Idempotency-Key. Owner читает
сохранённый результат без повторного эффекта по
[нормативному recovery протоколу](26_BROWSER_COMMAND_RECOVERY.md). Actor/scope
и текущие permissions проверяются заново; browser body хранить не требуется.

## Минимальный ответ Order Card

```json
{
  "orderRef": "ord_...",
  "version": "7",
  "projectionVersion": "19",
  "status": "Confirmed",
  "customer": {"customerRef": "cus_...", "displayName": "..."},
  "items": [],
  "pricing": {"totalMinor": "12500", "currency": "RUB", "quoteProofs": [{"quoteRef": "prq_...", "hash": "...", "expiresAt": "2026-09-01T10:15:00Z"}]},
  "aroma": {
    "state": "OutOfSync",
    "desiredRevision": "3",
    "observedRevision": "2",
    "lastObservedAt": "2026-09-01T10:00:00Z",
    "blockers": []
  },
  "allowedActions": ["request-aroma-reconciliation"]
}
```

Денежные значения и версии BIGINT передаются как decimal strings.

## Ошибки

Использовать RFC 9457 Problem Details со стабильным `code`. Обязательные коды первого запуска:

```text
ORDER_VERSION_CONFLICT
ORDER_QUOTE_STALE
ORDER_CONFIRMATION_REJECTED
CATALOG_MAPPING_MISSING
CATALOG_SNAPSHOT_INCOMPLETE
AROMA_PROVIDER_UNAVAILABLE
AROMA_UNKNOWN_OUTCOME
AROMA_MUTATION_FENCED
IDEMPOTENCY_CONFLICT
```
