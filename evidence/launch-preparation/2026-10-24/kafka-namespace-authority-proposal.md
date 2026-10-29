# Предложение: физические Kafka names verification run

Статус: явно разрешено владельцем 2026-10-24: «Разрешаю физические names с run-id».
Разрешение относится к описанной ниже verification-only проекции; фактический
broker inventory и PASS gates ещё должны быть доказаны.

Проверка literal criterion #13 обнаружила FAIL: `resources.kafkaPrefix` содержит
run-id, но actual broker topics/groups остаются canonical. Изолированный broker,
сеть и volume не являются доказательством names с run-id.

Предлагается сохранить canonical logical names и message envelopes, но только в
явно включённом verification режиме одного committed `platform.yaml` переводить
physical broker topic/DLQ/group names в `<exact-run-id>.<canonical-name>`.
Run-id берётся из уже проверенного readonly context с привязкой к SHA/base config;
произвольный prefix, overlay и env override не допускаются. Обычный runtime
сохраняет canonical names; production verification mode запрещён.

Область: shared config/runtime Kafka mapping, Kafka native boundary, bootstrap
топиков/offsets, Compose proof clients и G00/G19 фактическая проверка same mapping;
существующие тесты положительных/отрицательных boundary cases. Grants/ACL,
partition/retention/timeout, message schema и wire envelope не меняются. Runtime
получает только проверенные physical targets своих canonical claims. Для
consumer доказать обратное соответствие physical→logical, не расширяя allowlist.

Это исполнение naming criterion, а не waiver. Прежде чем PASS, записать actual
broker topic/group inventory с exact run-id и отсутствие canonical business
names в изолированном verification broker. Shared/production broker не трогать.

Альтернатива требует явного изменения criterion: принять canonical physical
names только внутри нового полностью изолированного per-run broker. Metadata
prefix сам по себе не сможет дать PASS и в этом варианте.
