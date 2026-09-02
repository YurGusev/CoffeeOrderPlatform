# `[3.3]` Effect Schema / HttpApi contract platform

## Результат

Issue #27 материализует единственный contract source CoffeeOrderPlatform:

```text
Effect Schema + HttpApi
→ runtime decode/encode
→ typed server handlers
→ typed HttpApi clients
→ generated OpenAPI 3.1
→ generated JSON Schema draft 2020-12
→ deterministic contract fixtures
```

Эта задача принимает `evidence/handoffs/issue-26.yaml` и не пересматривает
Effect BOM, module allowlist, topology, DB ownership, provider boundary или
business state machines.

## Не входит

`[3.3]` не переключает process lifecycle, HTTP server/runtime, config/time,
observability, PostgreSQL, Kafka и frontend remote state. Эти изменения принадлежат
соответственно #28–#31. Новые business routes, восьмое launch message, новый
runtime, DB или provider proxy также не создаются.

## Первый исполнимый срез

В начальном коммите добавлены:

- закрытая machine authority `config/effect-contract-platform.json`;
- companion JSON Schema draft 2020-12;
- dependency-free fail-closed validator;
- positive test и восемь RED fixtures;
- исполняемый Effect Schema/HttpApi probe, проверяющий deterministic OpenAPI 3.1,
  deterministic JSON Schema draft 2020-12 и Schema encode/decode;
- отдельный read-only GitHub Actions gate.

Probe использует только служебный путь `/__authority/contract-platform`; он не
является public/business API и не входит в runtime image. Его назначение —
защитить production contract cutover до появления первых owner schemas.

## Физические границы contract source

| Surface | Source root | Потребитель |
|---|---|---|
| `client-v1` | `packages/contracts/src/client-v1` | `api-public`, web typed client |
| `internal-v1` | `packages/contracts/src/internal-v1` | `api-internal`, owner runtimes |
| `events` | `packages/contracts/src/events` | Kafka producers/consumers |

`client-v1` и `internal-v1` не объединяются в общий DTO package. Frontend не
может импортировать `internal-v1`. Event schemas остаются versioned и не
заменяют PostgreSQL business state.

## Legacy cutover

До acceptance #27 должны быть атомарно удалены как contract authority:

- handwritten OpenAPI source;
- `@hey-api/openapi-ts` transport generation;
- generated DTO/SDK/client как source of truth;
- AJV mirror contract schemas.

Исторический PR #22 не переписывается. Временные legacy entries удаляются через
closed-shrink-only inventory #26; новый legacy use запрещён.

## Доказательство

Минимальные проверки первого среза:

```text
python3 scripts/validate-effect-contract-platform.py
python3 -m unittest tests.authority.test_effect_contract_platform -v
node scripts/run-effect-contract-platform-probe.mjs
git diff --check
```

Acceptance всей задачи дополнительно требует materialized owner contract
packages, deterministic generated artifacts, runtime decode/encode tests,
client/internal import isolation, removal proof старого contract stack и
`evidence/handoffs/issue-27.yaml` с exact accepted commit.
