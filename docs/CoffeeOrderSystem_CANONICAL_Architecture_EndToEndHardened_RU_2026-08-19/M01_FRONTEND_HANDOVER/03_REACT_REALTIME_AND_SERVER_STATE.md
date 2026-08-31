# M01. React realtime и server-state model

## 1. Source of truth

React/TanStack Query cache не является business truth. Авторитетное состояние всегда перечитывается из `client-v1` Platform API.

## 2. Realtime pattern

Основной target:

```text
Domain/Kafka event
→ coffee.realtime.invalidate.v1
→ Node Realtime Gateway
→ SSE
→ React invalidateQueries()
→ authoritative GET /api/client-v1/...
```

Realtime push содержит invalidation/hint, а не новый полный mutable aggregate.

## 3. Почему SSE first

Для operator UI основной поток server→browser. SSE проще, чем full-duplex WebSocket, и хорошо подходит для invalidation/status events.

WebSocket вводится для будущего web-chat/duplex requirement отдельным контрактом.

## 4. Degradation

Realtime outage не должен делать UI бесполезным. Critical screens имеют bounded fallback refresh/manual refresh. Поллинг не должен быть агрессивным и не становится source of truth.

## 5. Auth

Browser получает short-lived realtime ticket/credential через `client-v1` Platform API. Realtime Gateway валидирует scope/expiry и не принимает произвольные entity/customer IDs как authorization source.

## 6. Coalescing

Несколько быстрых domain events могут схлопнуться в:

```text
orders.changed(orderRef)
```

чтобы не создавать N одинаковых refetch. Coalescing ephemeral; потеря hint не меняет business state.
