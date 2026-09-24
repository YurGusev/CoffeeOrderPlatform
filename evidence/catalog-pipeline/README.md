# Catalog pipeline: проверка #18

Дата прогона: 2026-09-24. Начальный checkout: `develop@5e19c949b3ab72e1d390687564f34161f922ca68`; перед handoff принята более поздняя `develop@72305d67d2066cce317af33bf6ee78fd35789451` (#71, только docs/wave-2). Docker PostgreSQL в отдельных удаляемых контейнерах; Kafka broker, постоянная БД и production Gateway здесь не участвовали.

## Измерение ingestion

`pnpm test:catalog-capacity`: 58 passed, 0 skipped, около 45 с. Отдельный прогон `node --test tests/catalog-pipeline/capacity.test.mjs`: 1 passed, 0 skipped, 3.8 с.

- 100 000 **различных** offer identities, 200 batches × 500 offers; максимальный
  размер batch 259 501 байт при лимите 2 097 152 байта.
- NDJSON wire: 51 956 650 байт; SHA-256 потока
  `b3ca13b37223c7de177805ba72e6175081d466791a2433080048d6eb7858c898`.
- В отдельном процессе `--max-old-space-size=96` показаны baseline RSS
  84 402 176, peak RSS 189 026 304, прирост 104 624 128 байт;
  peak heap 69 971 048 байт. В ином успешном прогоне прирост RSS —
  118 456 320 байт. Принятый **для новой fixture** регрессионный бюджет
  прироста RSS — 134 217 728 байт (128 MiB). Уже существующий 96 MiB
  бюджет другого теста не менялся.
- Пока первый batch не сохранён, reader перестал запрашивать данные;
  read-ahead ограничен 1 000 offers (два batches). Не удерживается полный
  список offers или batches: records генерируются по мере чтения.
- Это bounded deterministic persistence fixture на production NDJSON reader
  и importer, **не** запись 100 000 rows в PostgreSQL и **не** измерение
  пикового RSS фазы SQL activation.

## Live PostgreSQL и контракты

`pnpm test:catalog-pipeline`: 38 passed, 0 skipped, 33 с. Проверен
deterministic fake AROMA NDJSON stream → настоящий ImportStore/staging →
activation → Fastify Catalog API: order/gap, batch conflict, malformed JSON,
обрыв без terminal, аварийный разрыв source, same-hash replay (одна
durable batch), deadline и cancellation; проверены также producer-контракт,
предел 500 offers / 2 MiB и отбрасывание oversized batch. При отказах
прежняя активная revision и API сохраняются;
при успешном переключении наблюдались целые revision 2 и 3.

Четыре участвующих runtime — `aroma-gateway`, `catalog-supplier-sync`,
`catalog-activation-worker`, `catalog-service`: их PostgreSQL роли получили
доступ только к своей БД/схеме, 16 проверенных попыток чужого CONNECT
отклонены с SQLSTATE `42501`. Проведены проверки secretRefs, synthetic
canary в API-error/log/telemetry и shape producer Outbox payload;
полные строки offers/products/variants в payload не допускаются. Это не
проверка реального Kafka broker и не end-to-end тест Collector/trace exporter.

`pnpm contracts:check-generated`, `pnpm contracts:breaking`, `pnpm
contracts:test`, `pnpm architecture:check` и `pnpm db:smoke` прошли;
полные duration и counts обязательных проверок остаются в handoff.

`pnpm test:catalog-recovery`: 6 passed, 0 skipped, 78 с. Отдельные OS
process завершаются SIGKILL после durable batch, до/после activation COMMIT,
до finalize Outbox и после Published COMMIT; новые процессы возобновляют
операцию с теми же durable message IDs. Проверены старые/новые ревизии при
конкурентных API reads и инвалидирование signed cursor. Publisher test
использует fake sender после PostgreSQL lease — это доказательство
Outbox/restart, но не actual Kafka send, rebalance или broker offset commit.

`pnpm check` и `pnpm db:live-proof` завершились с exit 0. Вне области
проверки: производственный Gateway/Provider, Kafka broker, PostgreSQL migration
ledger на постоянном сервере, telemetry Collector и production rollout.
