---
name: reliability-verification
description: Выбирать и выполнять проверки CoffeeOrderPlatform для контрактов, сервисов, БД, Kafka, отказов провайдера, browser flows, security, capacity, recovery и SLO.
---

# Проверка надёжности

Результаты проверок не разрешают deployment или внешнюю мутацию.

Выбирать пропорциональные слои: domain/property tests на Vitest и
`@effect/vitest`; Effect source contracts и deterministic OpenAPI/JSON Schema
artifacts; PostgreSQL integration/concurrency на настоящем PostgreSQL; Kafka
duplicate/crash/replay/rebalance через production adapter; provider
timeout/response-loss/UnknownOutcome; Compose health/shutdown; существующие
browser flows/accessibility; trust/security negatives; capacity/backpressure/SLO;
backup/restore drills. Новые tests на `node:test` не добавлять.

Infrastructure admission `#55` — небольшой orchestrator существующих checks и
proof отсутствия legacy paths. Не превращать его во второй полноценный
verification framework: exhaustive failures, capacity, recovery и SLO
принадлежат `#13`.

Не ослаблять контракты под реализацию. Фиксировать команды, evidence,
пропущенные проверки, остаточный риск и rollback/disable path. До включения
живой мутации AROMA доказать отсутствие blind retry, отклонение stale fence,
сохранение состояния после failed GET и reconciliation после restart.
