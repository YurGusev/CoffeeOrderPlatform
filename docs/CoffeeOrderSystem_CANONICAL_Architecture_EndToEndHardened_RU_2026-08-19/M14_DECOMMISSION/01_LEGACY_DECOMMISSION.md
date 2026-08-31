# 26. Decommission legacy C# и старого frontend tree

## 1. Decommission — отдельная фаза

Код не удаляется сразу после первого успешного canary. Удаление происходит после evidence window.

## 2. Frontend

После `platform/apps/web` cutover:

1. старый web image остаётся rollback artifact;
2. `src/CoffeeOrderSystem.Web` заморожен;
3. новые commits туда запрещены;
4. после soak/rollback-window source удаляется;
5. immutable old image сохраняется согласно release retention.

## 3. Bounded context

Удалить C# context можно, когда:

- production routes 100% TS;
- DB writer 100% TS;
- Kafka consumers C# disabled;
- scheduled workers disabled;
- migration ownership transferred;
- rollback no longer depends on C# binary;
- evidence archived.

## 4. C# API process

Финальный критерий:

```text
legacy HTTP requests = 0
legacy background effects = 0
legacy DB writes = 0
```

за утверждённое observation window.

## 5. Database cleanup

Contract/drop старых columns/table only после закрытия rollback window и backup/restore validation.

## 6. Docs

Старые ADR/architecture docs помечаются `superseded`, но не удаляются без history reason. Новый MASTER становится source of truth.

## 7. Docker/CI

Удалить:

- old API Docker build;
- obsolete migration image;
- old Compose services;
- old .NET-only CI gates для production target;

но сохранить archive build instructions при необходимости historical recovery.

## 8. Definition of Done

- [ ] no C# production container;
- [ ] no `src/CoffeeOrderSystem.Web` active source;
- [ ] no old AI/VK runtime;
- [ ] no legacy workers;
- [ ] no legacy edge upstream;
- [ ] no legacy schema owner;
- [ ] production DR tested without legacy artifacts.
