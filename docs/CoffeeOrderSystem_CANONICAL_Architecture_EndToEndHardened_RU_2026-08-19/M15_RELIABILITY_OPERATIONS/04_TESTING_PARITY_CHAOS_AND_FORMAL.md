# 21. Testing: characterization, parity, distributed faults и formal scope

## 1. Главный принцип migration testing

Новая TypeScript реализация не считается корректной потому, что тесты зелёные. Она должна доказать **behavioral parity** с accepted C# behavior там, где semantics сохраняются.

## 2. Characterization tests

До переписывания bounded context фиксируются observable scenarios:

```text
input state/request
expected result
expected DB effect
expected event
expected error/conflict
```

Это защита от «улучшить» старую бизнес-семантику случайно.

## 3. Frontend parity

Copy-first React должен пройти исходные:

- unit/component;
- architecture/feature boundaries;
- CSP;
- bundle budget;
- Playwright;
- accessibility;
- production smoke.

Первый target build не должен одновременно менять UX.

## 4. HTTP parity harness

Один request fixture исполняется против:

```text
legacy C#
platform TS
```

Сравниваются:

- status;
- content type;
- ProblemDetails/error class;
- semantic JSON;
- sorting/pagination;
- mutation result;
- idempotency/conflict behavior.

Поле timestamp/trace IDs нормализуются.

## 5. Property-based parity

Особенно для Orders/AROMA:

```text
quantity/weight/grind combinations
prices
versions
status transitions
Desired/Observed combinations
retry/unknown outcome states
```

Генерировать тысячи/десятки тысяч scenarios и сравнивать C# vs TS decisions.

## 6. Database integration

Использовать реальный PostgreSQL container, не in-memory substitute, для:

- transactions;
- isolation;
- unique constraints;
- locks;
- `FOR UPDATE SKIP LOCKED`;
- outbox/inbox;
- deadlock/retry cases.

## 7. Kafka deterministic tests

Проверять последовательности:

```text
event
same event duplicate
crash after DB commit before offset commit
rebalance
out-of-order across keys
same-key sequence
consumer restart
```

Результат business state детерминирован.

## 8. Fault injection

Добавить Toxiproxy/эквивалент в integration Compose.

Inject:

```text
latency
timeout
connection reset
bandwidth limit
provider 429/5xx
lost response after accepted request
```

Между:

```text
Platform<->Postgres
Platform<->Kafka
Dispatcher<->Hermes
AROMA Gateway<->AROMA stub
Payments<->provider stub
```

## 9. Chaos scenarios

- kill Kafka broker;
- stop Debezium connector;
- restart API during transaction flow;
- restart Hermes shard;
- restart Postgres in shadow environment;
- drop Nginx upstream;
- kill realtime gateway with active SSE;
- provider outage.

## 10. UnknownOutcome tests

Обязательны для AROMA/Payments и любых unsafe external operations:

```text
provider performed effect
response lost
```

Система должна reconcile, а не blind-retry.

## 11. TLA+ scope

Не моделировать всю платформу.

Высокая ценность только для двух протоколов:

### AROMA convergence

Проверяем invariants:

```text
stale owner cannot commit
one effective mutation owner
unknown outcome not blindly repeated
observed state not fabricated
```

### Payment lifecycle

```text
duplicate webhook cannot double-complete
refund <= captured amount
wrong order cannot be completed
provider unknown outcome reconciles
```

## 12. Performance tests

Разделить:

- microbenchmark SQL/hot methods;
- HTTP load;
- Kafka throughput;
- SSE connections;
- Hermes turn load;
- end-to-end scenario.

Не делать вывод о всей системе из одного k6 RPS числа.

## 13. Migration gate

Перед DB5/cutover конкретного context:

- [ ] characterization green;
- [ ] parity green;
- [ ] integration green;
- [ ] idempotency/replay green;
- [ ] load meets SLO;
- [ ] fault injection green;
- [ ] rollback procedure proven.

## BusinessLogicHardened: Orders/AROMA model verification

Property/model tests должны рассматривать минимум пять ортогональных state machines: Order lifecycle, Desired/Convergence, OrderItem fulfillment, Checkout, Payment. Тест не должен «упрощать» их в один статус.

Обязательные invariants:

```text
Draft never contributes to target AROMA cart
Confirm commits no external HTTP side effect
Only contributing Desired sources affect cart target
Failed GET never proves empty cart
Unsafe mutation attempt sends at most one provider request
UnknownOutcome cannot blind-retry
Stale fencing token cannot commit terminal convergence state
Checkout freeze requires exact current Desired=Observed proof
Invoice materialization requires frozen checkout + linked wholesale proof
Completed requires verified/audited customer payment, not supplier fulfillment
```

Legacy `AromaCartFillBatch` tests могут быть источником edge cases, но parity pass не требует воспроизводить batch-oriented architecture.
