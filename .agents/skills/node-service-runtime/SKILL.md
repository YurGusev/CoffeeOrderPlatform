---
name: node-service-runtime
description: "Создавать или проверять production-сервисы Node.js/Fastify CoffeeOrderPlatform: границы процессов, deadlines, pools, validation, observability и graceful lifecycle."
---

# Runtime сервисов Node.js

Основа: зафиксированный Node.js 24 LTS, строгий TypeScript, Fastify-first, один
процесс на контейнер, ограниченная конкурентность, отмена и OpenTelemetry.

- Один composition root на runtime; не вводить вторую framework/DI модель.
- У каждого маршрута есть схемы request, response и error.
- Передавать AbortSignal, deadline, trace, correlation и causation.
- Ограничивать DB, HTTP, Kafka, SSE, память, body size и in-flight work.
- Использовать только allowlisted typed clients; произвольные URL запрещены.
- Одна полученная connection на транзакцию с освобождением в `finally`.
- Не выполнять синхронную/CPU-heavy работу в request или consumer path.
- Корректно останавливать зависимости и публиковать health/readiness/telemetry.

Проверять typecheck/lint/tests, отмену, давление на pool, остановку под нагрузкой,
event-loop delay и здоровье контейнера.
