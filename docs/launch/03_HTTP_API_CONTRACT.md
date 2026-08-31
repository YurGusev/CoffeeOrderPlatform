# Контракт HTTP API

## Клиентские маршруты первого запуска

```http
POST /api/client-v1/customers
GET  /api/client-v1/customers?query=
GET  /api/client-v1/catalog/products?query=&availability=
POST /api/client-v1/pricing/quotes
POST /api/client-v1/orders/drafts
PUT  /api/client-v1/orders/{orderRef}/items/{itemRef}
DELETE /api/client-v1/orders/{orderRef}/items/{itemRef}
POST /api/client-v1/orders/{orderRef}/commands/confirm
POST /api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation
GET  /api/client-v1/orders/{orderRef}
GET  /events
```

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

## Минимальный ответ Order Card

```json
{
  "orderRef": "ord_...",
  "version": "7",
  "status": "Confirmed",
  "customer": {"customerRef": "cus_...", "displayName": "..."},
  "items": [],
  "pricing": {"quoteRef": "prq_...", "totalMinor": "12500", "currency": "RUB"},
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
