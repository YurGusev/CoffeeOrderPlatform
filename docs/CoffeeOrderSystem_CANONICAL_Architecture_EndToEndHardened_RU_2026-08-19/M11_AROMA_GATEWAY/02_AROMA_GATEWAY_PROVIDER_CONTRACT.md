# M11. AROMA Gateway Provider Contract

## 1. Gateway purpose

Gateway скрывает provider protocol и credentials. Он не принимает business-level команды вроде `sendOrderToCart(orderId)`.

## 2. Разрешённые primitives

```text
readCurrentCart(profile)
readWholesaleOrders(profile, window)
readProductAvailability(product identity)
resolveCatalogCandidate(query)
addCartLine(offer, quantity, grind, packing)
setCartLineAbsoluteQuantity(cartItemId, offer, quantity, ...)
deleteCartLine(cartItemId, ...)
```

Mutation primitive выполняет **ровно один provider request**.

## 3. Запрещено Gateway

- вычислять Desired target;
- решать, надо ли повторять mutation;
- хранить OrderId как authority;
- публиковать `OrderConfirmed/Completed`;
- самостоятельно создавать invoice/payment;
- писать Orders/Catalog/Invoices/Payments tables;
- делать callback в Orders после mutation.

## 4. Result semantics

Provider transport result разделяет:

```text
AcknowledgedResponse
RejectedResponse
TransportUnknown
SafeReadFailed
AuthUnavailable
RateLimited
```

`TransportUnknown` после unsafe request передаётся caller без автоматического повторения.

## 5. Session/cookie state

Session ownership техническое. Потеря session не меняет Desired/Observed truth. Auth recovery может повторять safe GET; unsafe request после неопределённого provider result не replay.

## 6. Connection/rate limits

Gateway имеет отдельные bounded pools/quotas. Orders convergence scale не должен бесконтрольно умножать provider concurrency.

## 7. Security

Provider credentials доступны только Gateway. React/Hermes/Orders domain code видят normalized internal contract.

## Service audiences and method-level capability separation

Gateway authorizes **route/method capability**, not only network source.

| Audience | Caller | Allowed |
|---|---|---|
| `aroma.catalog.read` | catalog-supplier-sync | complete wholesale catalog GET only |
| `aroma.cart.observe` | aroma-observer | cart safe GET only |
| `aroma.cart.mutate` | aroma-convergence | cart GET + narrowly typed add/set/delete |
| `aroma.wholesale.read` | aroma-checkout-poller | wholesale safe GET only |

`catalog-supplier-sync` credential/audience physically cannot call cart mutation routes. Where provider supports separate credentials, read-only and cart sessions/credentials are separated; otherwise Gateway still enforces internal audience/method allowlist.

No generic proxy endpoint accepting arbitrary method/path/header is allowed.
