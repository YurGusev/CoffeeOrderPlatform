---
name: reliability-verification
description: Выбирать и выполнять проверки CoffeeOrderPlatform для контрактов, сервисов, БД, Kafka, отказов провайдера, browser flows, security, capacity, recovery и SLO.
---

# Проверка надёжности

Результаты проверок не разрешают deployment или внешнюю мутацию.

Select proportional layers: domain/property tests; OpenAPI/JSON Schema;
PostgreSQL integration/concurrency; Kafka duplicate/crash/replay/rebalance;
provider timeout/response-loss/UnknownOutcome; Compose health/shutdown; browser
E2E/accessibility; trust/security negatives; capacity/backpressure/SLO; and
backup/restore drills.

Не ослаблять контракты под реализацию. Фиксировать команды, evidence,
пропущенные проверки, остаточный риск и rollback/disable path. До включения
живой мутации AROMA доказать отсутствие blind retry, отклонение stale fence,
сохранение состояния после failed GET и reconciliation после restart.
