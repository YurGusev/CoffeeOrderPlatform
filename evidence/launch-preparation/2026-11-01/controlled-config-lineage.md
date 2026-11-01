# Изолированные конфигурации AROMA

Владелец 1 ноября 2026 согласовал ограниченные config-only дочерние состояния
для G16 и G18. Решение устраняет противоречие: G14 требует обычный
`mutationsEnabled=false`, G16 и исходное состояние rollback требуют `true`.
Это явное расширение исключения из одного SHA; само решение не означает PASS.

Основной кандидат `P` остаётся замороженным и чистым. В его единственном
`config/platform.yaml` сохраняются `verification.aromaSandbox=null` и
`services.aroma-convergence.mutationsEnabled=false`, включая состояние после merge.

- G16 получает отдельный commit с единственным родителем `P`. Разрешены только
  два изменения: точная ранее утверждённая `verification.aromaSandbox` policy
  со свежим публичным ключом RAM-signer и `mutationsEnabled:false→true`.
  Signer создаётся непосредственно перед этой фазой; private key остаётся
  только в памяти. Approval связывает фактические child SHA/run ID, аккаунт
  и свежий выбранный offer. Существующие signature/TTL/single-use проверки,
  максимум две единицы, пустой baseline, семь фаз и точное восстановление
  baseline обязательны. Новый аккаунт или provider-операция не разрешаются.
- G18 получает отдельный baseline commit `B` с единственным родителем `P`.
  Его единственное изменение — `mutationsEnabled:false→true`; policy остаётся
  `null`. Затем выполняются существующие `B→D(false)→R` с точным возвратом
  config bytes `B`, фактическими runtime/recovery proofs и synthetic provider.
  Живой AROMA в G18 не вызывается.
- Каждый переход проверяется по полным Git trees, единственному parent,
  разрешённому parsed config diff и точным байтам остальных файлов.
  Context, run ID, config SHA, sealed bundle и результаты child связываются
  с `P`. Код, зависимости, pins, миграции, права и encrypted inventory
  идентичны `P`. OIDC-only validators G14/G15 сохраняют прежнюю область.
- Runtime image IDs и G12 provenance связываются с проверенным `P`.
  Несуществующий G12 child receipt не создаётся и не копируется. Parent
  принимает результат только после проверки всей lineage и успешного cleanup;
  неизвестный результат или незавершённое восстановление запрещают PASS.

G12 binding относится к существующему составу сканирования: product runtime
images и проверяемой инфраструктуре. Временный PostgreSQL fixture G16 в G12
не сканируется. Его отдельная проверка связывает registry digest из неизменного
parent BOM с фактическим image ID и существующими ownership/cleanup proofs;
это не выдаётся за G12 receipt или отсутствие уязвимостей этого fixture.

Лимиты сохраняются: G16/G18 по 1800 секунд, main 7200 секунд, отдельная
SSE qualification 2700 секунд. Новые сервисы, зависимости и постоянный IdP
не добавляются. Исторические evidence и неудачные попытки не переписываются.

Точные несекретные поля утверждённой policy сохранены в
[историческом evidence](../../aroma-provider/controlled-account.json)
без прежнего `trustedApprovers`. Это вход построения child, проверяемый по
hash и parent Git blob; runtime получает только итоговый committed
`config/platform.yaml`. Исторический config hash и commit сохраняют происхождение
policy, а недоступный через GitHub commit не требуется для нового checkout.

Нормативные связи: [спецификация запуска](../../../docs/launch/21_LAUNCH_VERIFICATION_SPEC.md),
[AROMA admission](../../../docs/adr/ADR-0034-g16-existing-account-verification.md),
[rollback lineage](../../../docs/adr/ADR-0035-launch-rollback-config-lineage.md).
