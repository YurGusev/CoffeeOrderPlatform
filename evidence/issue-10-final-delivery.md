# Финальная проверка AROMA Gateway — 20 сентября 2026

Этот документ описывает последний increment после `89366e6`; предыдущие отчёты
сохраняют результаты своих baseline и не заменяют проверки ниже.

## Принятые правила и граница #10

Владелец подтвердил количество целых упаковок/штук, цену одной упаковки/штуки,
выбор оператором одного из 12 помолов AROMA и упаковку `Aroma`, как в старой
системе. Вес фасовки не становится количеством в килограммах.

`sourceGrindKeyHash` — отдельный optional выбор команды/строки, а не новый
`offerRef`. Gateway экспортирует `grindOptions` (hash и название), разрешает
выбранный hash через каталог помолов AROMA и сохраняет выбор в durable journal.
Catalog #6 сохраняет/выдаёт эти варианты; Orders #11 хранит выбор оператора и
использует его в ключе сходимости. UI, staging/activation, scheduler раз в час и
Orders convergence не реализуются в #10.

Технический диапазон количества — целое `1..Number.MAX_SAFE_INTEGER`, чтобы
provider JSON number не терял точность. Это не заявление о максимуме поставщика:
stock-dependent limits, дроби, общий TTL и универсальные mutation semantics API
не выдумываются. Доказанные controlled responses, fail-closed decode, typed
rejection и UnknownOutcome определяют безопасное поведение при их изменении.
Zero/fraction/overflow отклоняются до reserve; unsafe retry отсутствует.

Упаковка `null` в чужой/старой корзине не превращается в `Aroma`. Неподдерживаемая
строка не удаляется и не скрывается: full snapshot завершается typed error.
Один offer с двумя разрешёнными помолами — две разные физические строки.

## Полный реальный каталог

[Transformed receipt](aroma-provider/2026-09-18-complete-catalog-export.json):
47 страниц, 464 продукта, 806 offers, 119 ground offers с 12 вариантами помола,
32 нулевые цены (Unavailable), один offer без изображения (`imageUrl: null`).
Выполнены login и 48 safe GET; cart mutations отсутствуют.

Использованы реальные ProviderHttpClient, ProviderSessionManager, catalog source,
decoder, exact RUB×100 normalizer, HMAC и NDJSON export. Persistence этого probe
была in-memory test boundary; он не доказывает запись в production Integration
DB. Raw bodies/IDs, имена товаров, credentials и cookies в receipt не сохранены.
Это не decoder fixture. Timestamp/hash относятся к одному traversal; поставщик
не предоставляет atomic snapshot/version guarantee.

Два более ранних последовательных read-only probe обнаружили fractional JSON
price на странице 17 и отсутствие фотографии на странице 19. Они завершились
ошибкой до полного export; успешный receipt выше относится к исправленному коду.
Денежный decoder сохраняет исходный JSON decimal token через `context.source`,
не восстанавливает деньги из уже округлённого Number. Nullable image — явная
коррекция internal response до принятия downstream: старый strict consumer
должен обновить generated contract; обратная совместимость для него не заявляется.

## Независимое ревью

Независимый reviewer повторно проверил три исправленных дефекта; открытых существенных замечаний нет:

- production composition передавала test normalizer override и пропускала
  чтение каталога помолов;
- persistence validation выбранного помола ошибочно требовала его отсутствия
  при сохранении Acknowledged;
- recovery ошибочно сравнивал отсутствующий в reservation grind field: достаточно
  существующего requestHash, который уже связывает выбор.

Независимая узкая проверка reviewer: production composition + journal —
22 passed, 1 expected live skip. Последний recovery fix проверен reviewer по коду;
отдельные live результаты приведены ниже.

## Проверки последней редакции

- Final-image binding/mTLS/restart proof: PASS; `coffee-aroma-final-current`.
- Final-image cart set/remove/read/restart/replay: PASS; тот же project, `--no-build`.
  В обоих случаях реальные PostgreSQL/mTLS/runtime, поставщик — local fake.
  Выбранный grind сохранён во всех четырёх journal rows; после restart provider
  mutations не повторились. SHA-256 journal JS в image совпал с локальным build:
  `cc0cf90469977feb334f17ac45b4c50fbdbc3db05fc4d7cd657dd19a63f23d70`.
- `pnpm security:secrets`: PASS; `pnpm db:smoke`: PASS (structural).
- Обычный `pnpm test:compose-smoke -- --project-name coffee-issue10-default-current`:
  PASS после rebuild всех 15 images; 15 healthy runtime, health/metrics,
  Kafka round-trip, retention после пересоздания и graceful shutdown.
  Перед командой trusted config-bootstrap материализовал canonical DB credentials
  в отдельный tmpfs; существующий bootstrap создал пять БД/десять runtime roles
  и применил available owner migrations на disposable PostgreSQL 17.11.
  Этот PostgreSQL был единственным временным узлом на `coffee_postgres_data`;
  общая БД/volume не использовалась. После команды DB container и tmpfs удалены.
  `stubSecrets=false`, но Kafka credentials/CA заменены только для локального
  ephemeral broker: `credentialSource=canonical-runtime-plus-local-kafka-fixture`.
  Это local acceptance, не production deployment и не proof внешнего Kafka.
- `pnpm test:aroma-mutation-recovery`: 19/19 PASS, без skips.
- `pnpm test:aroma-integration`: PASS; encrypted session round-trip, cleanup rows=0.
- `pnpm check`: exit 0; 364 tests, 348 passed, 0 failed, 16 baseline skips.
  Отдельный обязательный AROMA live journal gate выше выполнен без skips;
  общий suite не подменяет его. Contracts — 39/39; authority, config,
  architecture, lint, typecheck, breaking и generated checks — PASS.
- Generated aggregate SHA-256:
  `2464e66fe2c38de047411bbb4255ba0df6109c6ac4302eb7924c75dab11e0517`.
- `git diff --check`: PASS. 478 пользовательских файлов навыков/макетов
  совпадают с исходными hashes; `.agents`, `sketches` и отдельная пользовательская
  строка `docs/launch/README.md` исключены из commit.

Ранние прогоны не скрыты: первый общий suite имел два failure — отсутствующий
`defaultPacking` в старом scoping fixture (исправлен, 5/5) и PostgreSQL timeout
в `legacy-seed`. Отдельный live journal recheck остановился в foundation
commit-blackhole до journal scenario. Это не успешная проверка recovery;
окончательные последовательные результаты приводятся отдельно.

Первый cart proof использовал image до последней recovery-правки; он не выдан
за финальный. Затем image пересобран, hash проверен и cart proof повторён.

### Устранение нестабильности disposable PostgreSQL

Последовательный запуск также обнаружил timeout на `bootstrap-first`, до journal
scenario. Для одноразового PostgreSQL в существующем `scripts/db-live-proof.mjs`
добавлен tmpfs `/var/lib/postgresql/data`, как при подготовке default Compose выше.
Production pool/transaction/statement timeouts не менялись. После этого live
journal — 19/19, session integration и общий suite прошли. Проверяется реальный
PostgreSQL/WAL/COMMIT, повторное подключение и restart Gateway; переживание
перезагрузки хоста этим временным fixture не доказывается.

## Delivery

Код готов к merge. Единственный незакрытый процессный пункт issue — принятие
handoff и проверка prerequisites #6/#11 после merge. GitHub CI не настроен;
локальные результаты выше не выданы за remote checks. Merge и deployment
не выполнялись.
