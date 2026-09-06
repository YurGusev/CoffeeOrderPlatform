---
name: node-service-runtime
description: "Создавать или проверять production-сервисы Node.js/Fastify CoffeeOrderPlatform: границы процессов, deadlines, pools, validation, observability и graceful lifecycle."
---

# Runtime сервисов Node.js

Основа: зафиксированный Node.js 26 Current, строгий TypeScript, Fastify-first, один
процесс на контейнер, ограниченная конкурентность, отмена и OpenTelemetry.

Compiler authority по ADR-0022: только TypeScript 7 native Go `tsc`.
Точные версии toolchain брать из `config/toolchain-versions.json`.
TS5/6 compatibility lane, compiler API, custom transforms, CommonJS и
non-erasable syntax запрещены. Backend — ESM/NodeNext/ES2025 с `.js` runtime
imports; Node native TypeScript допустим только для малых repository/admin scripts.
Oxlint+tsgolint дополняют, но не заменяют authoritative `tsc` typecheck.

Использовать Temporal для business time, Permission Model audit/enforce,
native fetch/Undici 8, `node:test` для runtime seams и встроенный TypeScript для
простых scripts. Экспериментальные FFI/SQLite/VFS требуют отдельного ADR.

- Один composition root на runtime; не вводить вторую framework/DI модель.
- У каждого маршрута есть схемы request, response и error.
- Передавать AbortSignal, deadline, trace, correlation и causation.
- Ограничивать DB, HTTP, Kafka, SSE, память, body size и in-flight work.
- Использовать только allowlisted typed clients; произвольные URL запрещены.
- Одна полученная connection на транзакцию с освобождением в `finally`.
- Не выполнять синхронную/CPU-heavy работу в request или consumer path.
- Корректно останавливать зависимости и публиковать health/readiness/telemetry.

По изменению и риску выбирать проверки typecheck/lint/tests, отмены, давления
на pool, остановки под нагрузкой, event-loop delay и здоровья контейнера.
