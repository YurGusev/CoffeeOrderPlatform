# M01 — Frontend Handover

## Цель

Перенести существующий React без rewrite из `src/CoffeeOrderSystem.Web` в `platform/apps/web` и сделать его каноническим frontend source.

## Зависимости

M00, M02, M03

## Документы программы

- `01_REACT_COPY_AND_HANDOVER.md`
- `02_REACT_WEB_DELIVERY_SERVER.md`
- `03_REACT_REALTIME_AND_SERVER_STATE.md`
- `FRONTEND_COPY_CHECKLIST.md`
- `frontend-handover.mmd`

## Definition of Done программы

Новый `platform-web` image прошёл build/CSP/E2E parity, `/app/*` переключён, старый React source удалён после soak.

## Общий backlog

См. `../IMPLEMENTATION_BACKLOG_BY_PROGRAMS.md` (раздел этой программы).

## Правило выполнения

Production ownership меняется только после explicit parity/failure/recovery evidence и проверки зависимостей.

## Agent skill новой архитектуры

Основной skill: `next-react-handover`.

Для значимых изменений также активировать `next-architecture-router`; для parity/cutover/rewrite — `next-verification-and-parity`. Legacy skills разрешены только как reference/evidence старой реализации.



## Связь с M19 API Architecture

Frontend HTTP/generated-client contracts следуют M19 `client-v1` и contract registry.

## Orders/AROMA UI adaptation

`04_ORDER_CARD_AROMA_UI_HANDOVER.md` удаляет target `sendToAromaCart` UI и заменяет его server-derived sync/read model.
