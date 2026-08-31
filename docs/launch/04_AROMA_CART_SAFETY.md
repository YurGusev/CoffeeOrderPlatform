# Безопасность корзины AROMA

## Владение

Orders владеет бизнес-намерением и восстановлением. AROMA Gateway владеет транспортом провайдера.

```text
Orders: Desired, Observed, Convergence, Attempt, Lease, Fence, UnknownOutcome
Gateway: login/session/cookies, typed GET/mutation, rate/circuit, DTO mapping
Catalog: persisted complete snapshot, offer mapping and availability facts
```

## Примитивы провайдера

Gateway предоставляет только приватные типизированные операции:

```text
getWholesaleCatalogSnapshot()
getCartSnapshot()
setCartLineQuantity(offerRef, quantity, operationRef)
removeCartLine(offerRef, operationRef)
```

It does not expose arbitrary URL/method/body and does not blind-retry unsafe
operations. Catalog identity may call only safe catalog reads. Mutation
audience is restricted to Orders convergence.

## Попытка convergence

```text
1. Получить долговечный lease и монотонно растущий fence epoch.
2. Проверить актуальность Desired revision.
3. Проверить последний полный снимок Catalog и активный mapping.
4. Зарезервировать одну точную операцию мутации.
5. Выполнить свежий GET корзины.
6. При равенстве сохранить InSync без мутации.
7. Выполнить не более одной мутации.
8. Выполнить свежий GET корзины.
9. Сохранить Observed и точный результат проверки.
10. Завершить попытку и освободить lease.
```

Timeout after step 7 persists `UnknownOutcome`. A new attempt must reconcile
with fresh GET and operation reservation before any further mutation.

## Правила обработки отказов

- Failed/partial GET never becomes an empty cart observation.
- Stale fence cannot persist success or start mutation.
- Mapping missing/stopped blocks positive quantity.
- A price change does not silently rewrite confirmed Order target.
- Kafka message is a wake-up/version hint, never proof of physical cart state.
- Reconciliation command cannot override safety checks.

## Граница секретов

Supplier-owned credentials remain outside Git, logs, Kafka and browser. They
are injected only into `aroma-gateway`; request/response logging is redacted.
