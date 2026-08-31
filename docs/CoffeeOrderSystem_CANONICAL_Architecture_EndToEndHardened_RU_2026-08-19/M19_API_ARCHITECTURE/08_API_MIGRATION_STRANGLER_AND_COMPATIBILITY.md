# M19. API migration: Strangler и compatibility C#→TypeScript

## 1. Главная цель

Переезд backend implementation не должен одновременно становиться API redesign.

Стабильный внешний контракт позволяет менять owner за Nginx:

```text
React
  ↓ /api/client-v1/catalog/...
coffee-edge
  ├── C# legacy
  └── TypeScript target
```

## 2. Language-neutral contract first

До route cutover:

1. извлечь/зафиксировать current observable contract;
2. создать canonical OpenAPI artifact;
3. TypeScript implements same contract;
4. contract tests проходят против обеих реализаций;
5. behavioral parity/characterization сравнивает semantics.

## 3. Shadow

Для safe reads можно выполнять:

```text
request
  -> C# authoritative response to caller
  -> TS shadow response
  -> compare normalized result
```

Shadow path не должен удваивать expensive/unsafe provider side effects.

## 4. Canary

Nginx route family переключается bounded cohort/explicit canary route на TS.

Canary evidence:

- exact source/image digest;
- route family;
- contract version;
- DB mode/owner;
- SLO/error comparison;
- rollback target;
- observation window.

## 5. Write cutover

Перед write route cutover должны совпасть:

```text
HTTP route owner = target TS
DB schema writer owner = target TS
migration ownership = target TS
```

Нельзя оставить C# background worker writer на той же schema после TS public write cutover.

## 6. Rollback

HTTP rollback к C# разрешён только если C# всё ещё schema-compatible и writer ownership rollback безопасно подготовлен.

После irreversible schema transition simple Nginx flip недостаточен.

## 7. React stability

React generated client не должен менять endpoint path/DTO только потому, что backend owner сменился C#→TS.

Если одновременно требуется API redesign, выполнить отдельную compatibility migration, а не смешивать две причины изменения.

## 8. Agent stability

Hermes tools должны сохранять capability semantics при смене implementation owner. Tool names/arguments не должны быть зеркалом внутренних controller names.

## 9. Event migration

При C#→TS смене producer owner новый producer обязан продолжать compatible event contract до explicit version migration.

Не создавать `OrderConfirmedTsV2` только из-за смены языка.

## 10. API decommission

Legacy endpoint удаляется после:

- zero route traffic;
- zero consumer usage;
- zero generated-client references;
- rollback window completed;
- replacement contract active;
- docs/contract registry status retired.
