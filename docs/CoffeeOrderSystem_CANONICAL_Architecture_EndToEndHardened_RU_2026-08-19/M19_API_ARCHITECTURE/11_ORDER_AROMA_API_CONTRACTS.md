# M19. Order / AROMA API contracts

Canonical client routes:

```text
GET  /api/client-v1/orders/{orderRef}
POST /api/client-v1/orders/{orderRef}/commands/confirm
POST /api/client-v1/orders/{orderRef}/commands/add-item
POST /api/client-v1/orders/{orderRef}/commands/change-quantity
POST /api/client-v1/orders/{orderRef}/commands/remove-item
POST /api/client-v1/orders/{orderRef}/commands/cancel
```

Draft create/update routes may exist as additive operations in `client-v1`, but lifecycle mutations use explicit commands.

`add-item/change-quantity/remove-item` are accepted only for current eligible `Confirmed` order before checkout freeze and require `expectedOrderVersion` decimal string.

No public `sendToAromaCart`, raw provider offer/cartItem IDs or retry-unsafe-mutation route.

Agent routes are defined in `openapi/agent-v1.yaml`; trusted confirmation proof is injected by backend/channel context.

Provider cart operations are private AROMA Gateway capabilities and are never part of client/agent API.
