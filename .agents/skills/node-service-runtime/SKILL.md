---
name: node-service-runtime
description: "Создавать или проверять production-сервисы Node.js/Effect CoffeeOrderPlatform: composition roots, Layer/Scope, deadlines, pools, validation, observability и graceful lifecycle."
---

# Runtime сервисов Node.js

Версии Node.js, TypeScript и tooling брать из `config/toolchain-versions.json`;
числовые pins в skill не дублировать. Backend — ESM с erasable TypeScript.

- Один `main` и один owner-local application `Layer` на runtime. Запускать через
  `NodeRuntime`; ресурсы приобретать в `Scope` и освобождать автоматически.
- `Effect.run*` допустим только в process roots, tests и repository scripts.
- Не вводить Fastify/Pino, второй DI/runtime framework, общий `PlatformLive`
  или Promise/`finally` lifecycle рядом с Effect lifecycle.
- В `#51` удалить заменённые `platform-http` и `platform-time` целиком; второй
  compatibility path не сохранять.
- HTTP строить на Effect Platform/HttpApi, время — на Clock/DateTime/Duration,
  validation — на Effect Schema, наблюдаемость — через Effect OpenTelemetry.
- Передавать Effect cancellation/deadline, trace, correlation и causation.
- Ограничивать DB, HTTP, Kafka, SSE, память, body size и in-flight work.
- Использовать только allowlisted typed clients; произвольные URL запрещены.
- Не выполнять синхронную/CPU-heavy работу в request или consumer path.
- Корректно останавливать зависимости и публиковать health/readiness/telemetry.
- Новые tests писать на Vitest и `@effect/vitest`; затронутые legacy tests
  переводить только owning cutover, не массовой переписью.

Проверять typecheck/lint/tests, Layer construction, отмену, давление на pool,
остановку под нагрузкой, event-loop delay и здоровье контейнера.
