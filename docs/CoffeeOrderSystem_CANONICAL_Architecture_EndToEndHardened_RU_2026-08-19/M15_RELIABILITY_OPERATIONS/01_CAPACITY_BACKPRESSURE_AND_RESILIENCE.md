# 17. Capacity, Backpressure и Resilience

## 1. Capacity-first

Каждый subsystem имеет workload equation и saturation metric.

Пример agent path:

```text
M = inbound msg/sec
A = agent-trigger ratio
T = tools/turn
L = avg turn duration

turns/sec = M*A
concurrent turns ≈ turns/sec*L
tool RPS ≈ turns/sec*T
```

## 2. Backpressure ladder

```text
Nginx admission
 -> Node bounded intake
 -> Kafka durable backlog
 -> bounded consumers
 -> Hermes run capacity
 -> model queue
 -> API/DB/provider limits
```

При saturation нельзя создавать unlimited promises/tasks.

## 3. Bulkheads

Разные resource pools:

```text
react-web
channel ingress
channel egress
realtime
Hermes dispatcher
Payments
AROMA
```

Отказ Hermes не должен остановить Catalog reads или payment webhook intake.

## 4. Timeout hierarchy

Outer timeout > внутренний operation budget, но все budgets bounded.

Не использовать случайный набор несогласованных таймаутов.

## 5. Retry budget

Для одной logical operation есть один owner retry policy.

Требования:

```text
max attempts
max wall-clock budget
exponential backoff
jitter
idempotency classification
non-retryable errors
```

## 6. Circuit breakers

Используются на внешних providers, не как замена backpressure.

Half-open probes bounded.

## 7. Rate limiting

Layered:

```text
Nginx coarse
Node channel-specific
actor/API-specific
provider/domain-specific
```

## 8. Saturation definition

Saturation достигнут, если:

- oldest work age растёт без восстановления;
- p99 устойчиво нарушает SLO;
- provider/DB/model достиг limit;
- autoscaling не восстанавливает backlog;
- error/retry amplification резко растёт.


## 9. Node runtime budgets

Для Node workload'ов обязательны не только RPS/CPU, но и event-loop utilization/delay, RSS/native memory, PostgreSQL connection budget, provider connection budget и per-client realtime buffer budget. Полный contract — `07_NODEJS_RUNTIME_SLO_AND_CAPACITY.md`.
