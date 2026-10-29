# ADR-0025: Fastify foundation и обязательная надёжность первого запуска

- Статус: принято владельцем проекта; materialization — issue #60.
- Дата: 2026-09-05.
- Владелец: Platform Architecture.
- Supersedes: техническое решение ADR-0024 и delivery chain #48–#55.
- Сохраняет: ADR-0019/0020/0021/0022, canonical business invariants,
  15 runtime, пять owner DB, trust/network segmentation и config/SOPS authority.

## Решение

Первый запуск использует принятый в #3 / PR #22 Fastify foundation. Effect
не применяется ни как runtime, ни как вспомогательная библиотека. Его переход
до business delivery отменён: преимущества единой модели не оправдывают для
этого запуска стоимость обучения и привязку HTTP/SQL/frontend к RC/unstable API.
Это решение о риске проекта, а не утверждение о нежизнеспособности Effect.

| Область          | Единственная authority                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| HTTP и lifecycle | Fastify, явный process composition root                                   |
| Выполнение       | async/await, AbortSignal, ограниченный concurrency                        |
| Контракты        | OpenAPI + общие JSON Schema definitions без DTO-дублей                    |
| Генерация        | types-only `@hey-api/typescript` по ADR-0022; fetch client принадлежит #9 |
| PostgreSQL       | `pg`, параметризованный SQL, owner-local atomic operations                |
| Доставка         | Confluent Kafka; PostgreSQL Idempotency/Inbox/Outbox                      |
| Frontend         | React Router + TanStack Query; SSE invalidation/refetch                   |
| Диагностика      | Pino, OpenTelemetry; Collector Contrib → OpenObserve                      |
| Тесты            | существующий `node:test` backend, Vitest frontend и Playwright            |

Версии редактируются в `config/toolchain-versions.json`; recovery восстанавливает
проверяемую materialization #3 без обновления pins. Новый observability backend
не устанавливается в #60: его issue фиксирует exact image digests, storage,
limits и configuration до реализации. Внутренний DI/framework и ORM не нужны.

## Что восстановление доказывает

Последовательная отмена PR #59 и PR #56 сохраняет git history. Промежуточный
index tree `3875c35aa77e82c1fb269992b7c54c97d8a1b1e0` отличается от accepted
#3 / PR #22 и #47 только отсутствием трёх файлов status-label automation,
удалённых PR #58. Это не hash конечного recovery tree.

ADR-0024 и handoff #48/#49 сохраняются byte-for-byte как исторические artifacts.
Их статусы и outputs описывают accepted commits тех задач, а не текущую authority.
При проверке historical hash читается `git show <acceptedMergeCommit>:<artifact>`;
пересчитывать исторический digest по новым файлам запрещено. Не-Effect навыки
issue-authoring и issue-delivery-closure сохраняются. Конечный tree дополнительно
содержит это решение, согласованные launch-документы и новый handoff.

## Обязательные незавершённые гарантии

#3 — исполнимый каркас, а не завершённый production runtime. Его Map-based
idempotency/Inbox/Outbox не допускаются к business durable effects. Возврат
Fastify не является их admission. Владельцы и prerequisites определены в
[delivery graph](../launch/13_DELIVERY_DEPENDENCY_GRAPH.md).

- [#61](https://github.com/YurGusev/CoffeeOrderPlatform/issues/61) — Runtime foundation: распространять AbortSignal/deadline, реально прекращать
  in-flight I/O, закрывать ресурсы в пределах shutdown budget; readiness зависит
  от обязательных ресурсов. Request disconnect не отменяет уже принятый durable intent.
- [#62](https://github.com/YurGusev/CoffeeOrderPlatform/issues/62) — PostgreSQL foundation: потеря ответа COMMIT означает OutcomeUnknown, а не
  rollback; повреждённое соединение уничтожается, terminal network work имеет
  deadline. Idempotency хранит canonical hash и replay результата атомарно с
  owner mutation; restart не разрешает повтор business effect.
- [#63](https://github.com/YurGusev/CoffeeOrderPlatform/issues/63) — Delivery foundation: business effect + Inbox Processed + новые Outbox rows
  фиксируются одной owner transaction; offset — только после durable результата.
  Claims/leases/retry state живут в PostgreSQL; partition revoke/drain и bounded
  in-flight обязательны. Ordering определяется по aggregate, SKIP LOCKED сам по
  себе не доказывает порядок публикации несколькими publishers.
- [#64](https://github.com/YurGusev/CoffeeOrderPlatform/issues/64) — Observability: производители #10–#12 не заменяют Collector/storage/alert
  evaluation. Operations реализует их до G14 #13. Потеря telemetry не блокирует
  business path; bounded buffering, drops, retention и redaction проверяются.

G12 supply-chain scan запускается после G07 config/security и до G08 migrations.
G10 integration, G11 recovery и G13 Compose требуют успешный G12, поскольку
используют проверенные runtime images; G13 также требует успешный G11. При FAIL
G12 независимые G08 и G09 могут пройти, а эти Kafka-consuming gates остаются
NOT_RUN. G19 сохраняет fail-closed решение и не превращает частичный run в допуск.

Contract task #4 может начаться после #60 независимо от runtime hardening.
Business writers ждут нужные foundation handoffs; общий Effect admission больше
не нужен. #50–#55 закрываются как superseded после merge #60, не как implemented.

## Масштабирование и эксплуатационные пределы

Сохраняются физические trust boundaries. Число процессов не является
доказательством производительности или HA. До launch acceptance требуется:

- fleet DB budget учитывает сумму `replicas × pool.max` и rollout overlap плюс
  admin reserve; текущие pool maxima исчерпывают application budget без запаса
  на дополнительные replicas;
- #12 запускает один realtime instance с `realtime-gateway-v1`; горизонтальное
  масштабирование требует fan-out каждому instance и отдельного решения;
- #12/#13 проверяют SSE RSS/FD и process-wide budget: произведение per-client
  buffer и connection limit не может бесконтрольно потреблять память;
- одна физическая AROMA-корзина сохраняет один fenced mutation lane; увеличение
  replicas не снимает provider serialization;
- #18 измеряет Catalog capacity на реальном dataset; timeout не заменяет замер;
- #18 раздельно фиксирует размер детерминированного NDJSON dataset, RSS и
  backpressure во время ingestion и подтверждает live recovery/API на
  disposable PostgreSQL. Замер ingestion не доказывает RSS SQL activation,
  а sender-fixture не доказывает доставку реальным Kafka broker;
- development Compose с single broker не считается production durability/HA.
  #13 требует доказанный persistence/restart и backup/restore в launch environment.

## Observability boundaries

Collector и OpenObserve — инфраструктура Operations вне каталога 15 business
runtime. Они не получают business DB credentials или права менять заказы.
Приложения пишут JSON logs в stdout; traces/metrics отправляют OTLP в Collector.
Collector читает логи через filelog и владеет backend exporter. Выбор single
node требует явного retention/disk/recovery бюджета и не обещает HA.

`orderRef`, `operationRef`, `attemptRef`, `messageId` и correlation связывают
расследование; высококардинальные identifiers не являются metric labels.
Одна ограниченная операция имеет trace; долгоживущий order связывает несколько
traces/links. G14 сохраняет сквозное доказательство browser→DB/Kafka→SSE→refetch
и реальные alert injections, не требует бесконечного span на весь order.
