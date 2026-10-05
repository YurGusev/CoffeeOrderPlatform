# Локальная интеграция consumer #9 с контрактом #11

Проверенный checkout: `/home/yurgusev/.codex/worktrees/issue-9-11-integration/CoffeeOrderPlatform`.
Исходная ветка #9: `feature/9-react-operator-flow`, HEAD
`adfca3f9df79a180ce84539c12c956e55c7e3b41`; общий backend base #11:
`e278aeb10e57d37485542f8668f078456074b038`.
Backend delta наложена в отдельный managed checkout; manifest/lock/generator
объединены трёхсторонне с сохранением browser scripts и Catalog runtime schemas.
Основная пользовательская рабочая директория и UI paths ветки #11 не изменены.

Выбор помола поступает из Catalog options. Optional hash одинаков в quote и
Orders PUT; отсутствие поля означает отсутствие выбора. Card отображает frozen
owner display name; изменение количества сохраняет выбранный hash. Unknown
выбор обрабатывается terminal create-quote 422, без PUT и нового recovery intent.
При исчезновении варианта stale выбор видим; явный сброс не передаёт hash.

## Проверки

Логи находятся в `/tmp/coffee-issue11-final-checks`:

- 105 `pnpm install --frozen-lockfile` — PASS, 42 workspace projects.
- 106 `pnpm contracts:generate`, 107 `pnpm contracts:check-generated` — PASS.
- 110 `pnpm test:web-queries` после build — PASS, 6 файлов / 15 tests.
- 114 `pnpm test:web-idempotency` — PASS, 6 Vitest tests и browser flow.
- 126 `pnpm test:web-routes` — PASS, typecheck/UI/Vite build и browser flows.
- Independent review I9-11REV001 — устранено; новых существенных замечаний нет.

Исторические FAIL 108/109/113/121/124 сохранены в receipts; они не считаются PASS.
Текущий Client OpenAPI SHA-256 `69b4ae3c7522abcb3e8a0927552507219bbab2b5bfd34bc0c28538384c921974`,
generated types SHA-256 `7e1aabbed1355a2e37f97fa142c24495febcbf5323a386a59d19012e9e6cb42e`:
byte-identical authoritative backend input. Runtime schemas включают также
Catalog schemas, которые generator #9 уже использовал для browser validation.

## Проверенный UI source

Fingerprint: SHA-256 sorted `path + NUL + sha256(file)`, joined LF:
`98bb2c30774b3e2480caebbd19c21a26996fda7a044b9cbbcc7c995e72c5e232` (текущий source; fixture delta I9-11REV002 проверена158/159/160).
Исторический проверенный126 fingerprint: `790868d3789fa98bdc45ff44873c182672535f29838a120b82acb2b5e0729708`.

| Файл | SHA-256 |
|---|---|
| `apps/web/src/browser/api/client.ts` | `f8e0f68fdfd7727988810dca043bc6ba55568d15d0888732af423c0b752a72fb` |
| `apps/web/src/browser/api/remote.ts` | `51939cc53c3aae9dcfc4536f1a1c0ac2145bdf49386b1fa5f806d9737727ba37` |
| `apps/web/src/browser/api/schema.ts` | `15bc7f12ee2041186d9e56df7b694c6b11fae899477b443516d3f544618bd1fb` |
| `apps/web/src/browser/routes/CatalogPage.tsx` | `24098c0eda500c911a3bc56a2ca52879381409652d0bf37934b7d745caccbd69` |
| `apps/web/src/browser/routes/OrderCardPage.tsx` | `364eba479ed8bc3917a4186d2fc590bde2483cc7308894ab7f68e3f1d0aa279f` |
| `apps/web/test/operator-flow.spec.ts` | `218c2e55cedf5ab07870e963600442979c8e8de41b397dd9f25da2e5966b0f26` |
| `apps/web/test/schema.test.ts` | `80c8f51d97fcd47168241c16b4ce9f26a4051231c09ab4234f65ba99b3f35dd6` |

Это локальный consumer proof с mock HTTP browser flows, а не acceptance
production/provider или публикация handoff. Full backend recovery и capacity
проверяются отдельно; remote PR/CI/merge не выполнялись. Checkout сохранён как
reviewable artifact. Итоговый runtime/contract overlay синхронизирован и проверен final164–166;
fresh full-build Compose167–169 также прошёл.

## Дополнение public Card после projections gate

146 обнаружил расхождение: definitive404 owner уже сохранял `Blocked` с
`AROMA_CART_ITEM_NOT_FOUND`, а public OrderBlocker enum его не принимал.
Single-enum delta исправлен в backend и managed inputs, native generation154
PASS; Card/typecheck15510/10 PASS, full projections156113/113 PASS.
Historical106/107/135 input hashesac38/0a80 относятся к прежнему срезу;
Runtime UI source не изменялся; test fixture delta после152 отражена ниже. Managed runtime schemas после этой
правки сохраняют Catalog defs и имеютSHA256
`369d395e54f53f63b79f935bc52e8d28ca94f3b4eca7f174a1916f1440358c26`.
Final151accessibility/159Playwright/153bundle PASS; новый wire shape или
UI implementation не вводились. Current performance gate145 остаётся открытым.

## Полный browser gate и CSRF fixture

150 lint/contracts48/check-generated/configPASS,151accessibility/buildPASS.
152 full browserFAIL: ожидание transient «Требуется вход» истекло30s.
I9-11REV002 confirmed root cause: rotated CSRF вызывает invalidation и очистку
intent, затем mock GET/auth/session200 быстро снимает invalidation. Проверяемый
тест и production session/idempotencyCSRF paths побайтно прежние #9adfca3.
Узкий test-only fix в existing addInitScript фиксирует once invalidation event;
wait проверяет событие и отсутствие intent. NoPOST/noStorage/cookie cleanup
assertions прежние; production session behaviour/timeout не менялись.
158 idempotency6/6+browser,159fullbrowser,153bundle139524/256000B и160lint — PASS. I9-11REV002 закрыт независимым ревью. Старый152FAIL сохранён.

## Итоговый локальный handoff

UI delta сохранён отдельно: `/tmp/coffee-issue11-final-checks/issue-9-consumer-delta.patch`,
SHA-256 `cce43a231be998c6bbf30b48ec1b509ac46a479916fc288006712df88c42550b`.
Он содержит ровно7 перечисленных UI files относительно #9HEADadfca3,
не backend/config/shared manifests. Managed checkout сохраняется для review;
primary tracked diff совпадает с исходным snapshotSHA970d4a9e1e89cf3b749811c75b4e1bdecbd0bf179cbc3afa3a081c62f217f8e2.
Full backend named164–166 и freshCompose167–169 PASS; это локальная совместная
проверка, а не remote accepted merge/CI.
