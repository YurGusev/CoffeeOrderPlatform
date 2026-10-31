# Браузерная корреляция наблюдаемости

Статус: решение принято владельцем 31 октября 2026; реализация и runtime proof ещё не завершены.
Основание: прямой ответ «Согласовать OIDC-механизм G15 для браузерной фазы G14 (рекомендую)».

## Подтверждённое противоречие

[Спецификация запуска](../../../docs/launch/21_LAUNCH_VERIFICATION_SPEC.md) требует для G14 один browser correlation id через edge → API → owner → DB → Outbox → Kafka → projection → Realtime → browser refetch. При этом раздел G15 разрешает OIDC-only дочерний checkout только для G15, оставляя G00–G14 на product candidate с `browserOidc: null`. При null production Edge не предоставляет session authority; реальный browser login G14 недоступен. Исторический component PASS #210 использует диагностическое окружение и не отменяет противоречие formal launch.

## Согласованное точное исключение

Разрешить существующий механизм OIDC-only дочернего commit также для одной browser-correlation фазы G14. Прямой родитель — исходный product candidate #13; единственное изменение конфигурации — `browserOidc: null` на уже разрешённый synthetic OIDC профиль G15. Production source, pins, grants, thresholds, DB/Kafka isolation и provider-mutation policy не меняются.

Дочерние SHA/run-id/config digest/DB/Kafka/evidence проверяются и связываются с родителем через существующий sealed lineage/bundle. Результат обязан прямо показывать отдельный SHA этой фазы; его нельзя выдать за выполнение всех G14 действий на буквальном parent SHA. Остальные фазы G14 остаются на product candidate. Evidence G13/G15 не перезаписывается. Runtime использует утверждённый внешний PostgreSQL; PostgreSQL container не создаётся. После проверки удаляются только собственные child ресурсы. Постоянный IdP и новый сервис не добавляются; normal deployment не использует synthetic профиль.

## Минимальные затрагиваемые места

- Нормативное исключение: `docs/launch/21_LAUNCH_VERIFICATION_SPEC.md`, связанное уточнение issue #13.
- Существующая lineage/credential validation: `verification/launch/v1/scenarios/browser.mjs`, `tools/config-bootstrap/browser-fixture.mjs` и их ближайшие tests.
- Callers: `tools/observability/verify.mjs`, `tests/observability/launch-path.mjs`, `tests/observability/orders-fixture.mjs`, `tests/realtime/fixtures/setup.mjs`, `tools/compose-smoke.mjs`.
- Проверки: child меняет только browserOidc; mismatched parent/SHA/config/namespace/role отклоняются; G13/G15 evidence неизменны; cleanup exact; реальный сквозной browser proof, не unit substitute.

## Ограничения

Это явно согласованное расширение существующего исключения из правила одного SHA. Оно не означает G14 PASS, не увеличивает 1800 секунд и не даёт launch admission. До реализации и фактической проверки lineage, браузерной корреляции и cleanup формальный G14 остаётся непринятым.
