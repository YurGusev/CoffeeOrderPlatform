# Tasty: конкретизация изолированной session #195

Статус: Accepted; владелец явно принял эту конкретизацию ADR-0038 в беседе 28.10.2026.
Это локальная fail-closed policy Integration, не измеренный lifecycle Tasty.

## Принятый локальный контракт

- `apps/tasty-gateway/src/infrastructure/provider/session.ts`: одна instance
  обслуживает один immutable scoped credential source. Account не выбирается
  входящим read-запросом; supplier/account/cartScope не приравниваются.
- Credentials предоставляет trusted `loadCredentials(signal)` только из будущей scoped tmpfs
  materialization #196. Runtime file paths и SOPS/config keys эта изолированная
  задача не вводит: ни SOPS, ни общий secret file модуль не читает.
- Login использует bounded transport #194 и body `login`, `password`,
  `device.{device_name,device_os,device_browser,device_timezone}`. Это наблюдённый
  payload, минимальная обязательность device fields не доказана. Принимаются
  только непустой `data.access_token`, `data.token_type: "bearer"` (исторический
  ответ) или `"Bearer"` (локальный fixture) и положительный безопасный целый
  `data.expires_in` в секундах. Другие схемы отклоняются. HTTP transport всегда
  формирует заголовок с `Bearer`; profile отбрасывается.
- Token существует только в private memory. В каждой instance только один
  in-flight login; concurrent acquisition разделяет его результат. Отмена
  отдельного waiter не отменяет общую попытку. Session использует тот же
  `timeoutMs`, что transport, для всей acquisition: загрузки credentials и login.
  Монотонный абсолютный deadline также проверяется после загрузки, HTTP и
  разбора ответа до сохранения; внутренний AbortController отменяет попытку при
  timeout. Trusted loader
  обязан учитывать signal; его запоздалый результат не запускает login и не
  сохраняется. Нет записи token, логирования body или раскрытия cause.
- Локальный reuse истекает по monotonic `performance.now()` от начала login
  плюс объявленный TTL. Следующий явный read после локального истечения может
  сделать один новый login; это не обещание реального срока жизни токена.
- Любая ошибка login или 401 business read очищает token и блокирует повторный
  login для данной instance. Повторный business read не выполняется. Возобновление
  требует явного пересоздания session trusted владельцем, автоматического reset,
  retry, refresh или logout нет. Поздний 401 от старого token не инвалидирует
  более новую session, token/TTL не обновляются запоздалым результатом. Каждый
  business 401 возвращает `TASTY_SESSION_UNAUTHORIZED`, включая запоздалый.
- Неверные operation или AbortSignal отклоняются до login с
  `TASTY_SESSION_INVALID_INPUT`.
- Сессия возвращает typed failure без provider body, token, credentials,
  profile и исходной exception cause. Production clock/deadline/config wiring,
  account/cartScope proof и runtime admission остаются #196.

## Проверка и принятый вход

`tests/tasty/provider-session.test.mjs` использует реальный `TastyHttpClient` #194
и локальный fixture server: success/error login и redaction, concurrent
acquisition/cancel waiter, локальное истечение, текущий и поздний 401 без replay,
изоляция instances, timeout loader и отсутствие refresh/logout. Для clock
используется synthetic `performance.now()`; deadline также ограничен реальным
timer. Основной fixture timeout 10000 мс больше скачка clock при TTL; 50 мс
используется только для зависшего loader.
Fixture TTL и synthetic clock не являются live expiry/revocation proof.
HTTP-клиент #194 принят в `develop` merge commit
`364c3034e91f168dcb51d94ef64e34389fc90b52` ([PR #206](https://github.com/YurGusev/CoffeeOrderPlatform/pull/206)).
Типы credentials и операций переиспользуются из `http-client.ts`;
`TastySessionTransport` — `Pick` его трёх необходимых членов.
Штатная сборка и весь набор `tests/tasty/*.test.mjs` прошли: 22/22,
включая 9 session-тестов. Временные ссылки или копии HTTP-клиента не нужны.

Проверки: `pnpm exec tsc -b apps/tasty-gateway --pretty false && node --test tests/tasty/*.test.mjs`,
`pnpm typecheck`, `pnpm lint`, `pnpm architecture:check`, `git diff --check` — PASS.
Live login, expiry/revocation и runtime admission не проверялись; подключение
scoped credentials/config остаётся #196.

## Входы

[ADR-0038](../../adr/ADR-0038-tasty-readonly-boundaries.md),
[наблюдения #184](session.md),
[конфигурация](../../launch/11_CONFIGURATION_AND_SECRETS.md).
Исторические заметки и статический JS подтверждают `data.access_token`,
`data.token_type`, `data.expires_in`; сырой login response не сохранён.
В сохранённом `http-evidence.json` (SHA-256
`4b9c132523826de7528adef56fe98fe9fd1d1c3a468be07f06dddeac341eb9ce`)
селектор `authorization.tokenType` равен `bearer`; это поле ответа отличается
от регистра `Bearer` в заголовке. Fixtures сохраняют это различие.

Публичный сохранённый `oVH4Lq42.js`, SHA-256 `2d34750850147a9d058481e02a413d05453d971fba89547277d266ffc0b17839`, bytes `[274650,276200)`, содержит поля device запроса и data ответа; историческая заметка приведена в [#184](session.md). REA evidence `ev_edb97549243d18417829752ee0910a41c1779e2a072cac1fec639b690f7dc389`: анализ exact source завершился timeout 30000 мс, сохранён только частичный результат. Это не полный анализ и не доказательство поведения сервера.
