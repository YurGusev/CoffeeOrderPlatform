# M19. API testing и acceptance gates

## 1. Contract tests

Для каждого active HTTP surface:

- request schema;
- response schema;
- status/errorCode matrix;
- auth requirements;
- required headers/cookies;
- operationId stability;
- no accidental extra PII.

## 2. C#↔TS parity tests

Migration endpoint contract должен прогоняться против legacy и target implementations.

Сравнивать не только JSON shape, но и:

- sorting/paging;
- permission outcome;
- conflict semantics;
- money rounding/decimal representation;
- date/time timezone semantics;
- missing/null/empty differences;
- rowVersion/concurrency;
- errorCode;
- side-effect decision.

Тест не переписывается под TS divergence без explicit approved contract change.

## 3. Negative trust tests

Обязательные:

- browser вызывает `agent-v1` -> denied/not routed;
- public caller вызывает `internal-v1` -> denied/not routed;
- Hermes supplies arbitrary customerId -> schema/tool disallows;
- user prompt содержит другой VK ID -> trusted identity unchanged;
- n8n attempts direct DB/domain unauthorized operation -> blocked;
- wrong service identity to internal route -> forbidden;
- malformed/oversized webhook -> rejected before domain work.

## 4. Webhook tests

- valid signature;
- invalid signature;
- replay/duplicate;
- out-of-order provider events;
- provider callback timeout/retry;
- accepted callback + process crash;
- amount/currency mismatch for payments.

## 5. Event API tests

- duplicate eventId;
- replay after consumer restart;
- malformed schema;
- unsupported schema version;
- out-of-order messages where key ordering matters;
- rebalance during processing;
- DLQ/recovery;
- producer owner migration C#→TS compatibility.

## 6. Realtime tests

- reconnect;
- dropped hint followed by polling/fresh read;
- authorization expiry;
- wrong subscription scope;
- multi-replica fan-out;
- slow-client backpressure.

## 7. Load/capacity

Отдельные profiles:

```text
client API RPS/p95/p99
VK callback RPS + durable ACK
payment webhook burst
SSE concurrent connections
event API lag/oldest age
Hermes agent-v1 tool RPS
provider API quota saturation
```

Не использовать один общий «API handles 10k users» metric.

## 8. OpenAPI/schema CI

Merge gate:

- spec valid;
- generated TS client reproducible;
- breaking-change detector clean/approved;
- internal route not in public Nginx inventory;
- event schema compatibility clean;
- examples validate against schema.

## 9. Release acceptance

API program считается production-ready для route family только если:

- contract owner identified;
- auth/trust tests pass;
- SLO baseline exists;
- error/idempotency semantics documented;
- observability includes route/event owner + traceId;
- rollback/sunset strategy recorded;
- DB writer ownership matches route owner for writes.
