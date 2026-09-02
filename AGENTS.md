# Руководство для агентов CoffeeOrderPlatform

Этот репозиторий содержит новую CoffeeOrderPlatform, строящуюся с нуля. Запрещено переносить из CoffeeOrderSystem runtime-код, модели БД, generated artifacts и внутренние типы.

Перед значимой работой прочитать `docs/launch/README.md`, `docs/adr/ADR-0023-effect-native-platform.md`, `docs/launch/26_EFFECT_NATIVE_FOUNDATION.md`, применимый канонический revision root и `.agents/skills/coffee-platform-router/SKILL.md`.

## Ветки и язык проекта

- GitHub `YurGusev/CoffeeOrderPlatform` — единственная operational authority.
- `develop` — единственная постоянная ветка разработки; `main` — стабильная/релизная линия.
- Ветка создаётся только от `develop`, содержащей accepted predecessor: `feature/<issue>-<slug>`, `fix/<issue>-<slug>`, `docs/<issue>-<slug>` или `test/<issue>-<slug>`.
- Один issue — одна ветка — один PR только в `develop`.
- Issue, commits, PR и изменяемая документация ведутся на русском; технические identifiers не переводятся.
- Каждый issue обязан содержать predecessor, inputs, outputs, downstream consumers, подробный checklist, tests, границы и критерий готовности.
- `- [x]` ставится только после фактической реализации и evidence; blocked/skipped пункт остаётся `- [ ]`.
- Документация меняется в том же PR, что и поведение.

## Неприкосновенные архитектурные ограничения

- Ограниченный контекст владеет своими данными, migrations, commands, events и recovery.
- Cross-owner SQL, imports внутренних реализаций и shared mutable business entities запрещены.
- PostgreSQL — business truth; Kafka — transport committed facts/wake-up; Outbox/Inbox защищают эффекты доставки.
- `edge-gateway`, `api-public`, `api-internal`, realtime и provider trust surfaces разделены.
- AROMA Gateway владеет transport/credentials/journal; Orders владеет convergence.
- Frontend использует только `client-v1`, server state и `allowedActions`.
- Все открытые настройки находятся только в `config/platform.yaml`; secrets — только в encrypted `secrets/platform.secrets.sops.yaml` и runtime-scoped tmpfs materialization.
- Provider egress разрешён только `aroma-gateway`.
- Unsafe AROMA mutation никогда не получает automatic retry.

## Effect-native authority

После принятия ADR-0023 любая новая effectful backend-реализация строится только на Effect.

- `Effect` — execution model; самостоятельные Promise-workflow в application/infrastructure запрещены.
- `Context.Service` и owner-local `Layer` — DI/composition. Общий `PlatformLive` нескольких bounded contexts запрещён.
- `NodeRuntime`, `Layer.launch`, `Scope` — process lifecycle.
- Effect `Schema` + `HttpApi` — source HTTP contracts и runtime validation.
- Effect `HttpRouter`/`HttpClient`/`Stream` — HTTP и streaming.
- `@effect/sql-pg` + Coffee transaction policy — единственный SQL stack.
- Effect `Clock`/`DateTime`/`Duration`/`TestClock` — time model.
- Effect logs/spans/metrics + `@effect/opentelemetry` — observability.
- Vitest + `@effect/vitest` — backend runtime/application tests.
- `@effect/atom-react` + `AtomHttpApi` — frontend remote-state.

Запрещено создавать `platform-effect`, `coffee-effect`, `AppEffect` или другую обёртку над Effect.

### Production boundaries

- `Effect.run*` разрешён только в process/browser runtime roots, tests и approved tooling.
- `Effect.provide` и Layer composition разрешены только в `layer.ts`, `main.ts`, tests и узких platform Layer factories.
- Application use case получает dependencies через requirements channel и не собирает их самостоятельно.
- Effect `Ref`, `Queue`, `Cache`, `Fiber` и `Schedule` не являются durable storage.
- RPC/Workflow/Persistence/EventLog/Cluster модули запрещены без отдельного ADR.
- Safe GET retry и unsafe mutation no-retry являются разными capability policies.
- Direct `pg`, Confluent client и browser transport доступны только соответствующим platform adapters.

### Правило перехода #25–#32

Существующий код PR #22 допускается только как закрытый legacy inventory до owning cutover. Новое использование старого стека запрещено.

```text
старый путь
→ новый Effect-path и proofs в owning PR
→ удаление старого пути в том же PR
→ no feature flag / no fallback / no dual-run
```

#4 и business issues не начинаются до merge #32 и решения `ДОПУСТИТЬ EFFECT FOUNDATION`.

## Scope Guard

До правок сформулировать:

- **Результат** — точное поведение;
- **Не входит** — что не делается;
- **Файлы** — минимальный набор;
- **Доказательство** — команды и observable result.

Во время правок:

- переиспользовать существующие patterns;
- исправлять первопричину;
- не расширять capability/owner boundary;
- не добавлять abstraction «на будущее»;
- удалять заменённый путь;
- не менять тест под реализацию, если тест выражает принятую authority;
- не отмечать checklist раньше проверки.

Задача завершена только если acceptance выполнен, tests/evidence относятся к exact SHA, diff не содержит несвязанных изменений и отсутствуют debug/scratch/dead paths.

## Операционные ограничения

Работать локально в `/home/yurgusev/CoffeeOrderPlatform`. GitHub push, issue/PR mutation, deployment, provider mutation и production data write выполняются только по явному разрешению пользователя.

Канонические revision roots неизменяемы. Новые решения оформляются русскоязычными ADR, executable contracts, tests и handoffs.
