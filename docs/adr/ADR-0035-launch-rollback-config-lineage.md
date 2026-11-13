# ADR-0035: отдельная история config для гейта `rollback`

Статус: решение принято владельцем 24 октября 2026; lineage и runtime сценарий реализованы, runtime PASS пока не получен.<br>
Основание: явное разрешение на config-only commits для `rollback` в ходе #13.

## Контекст

Один clean candidate SHA должен определять продукт, зависимости и миграции всего
launch run. `aroma_sandbox` требует versioned `mutationsEnabled=true`, а `rollback` проверяет
committed переключение в `false` и возврат исходного config digest. Оба состояния
одного tracked файла не могут одновременно принадлежать одному commit.

## Решение

По дополнительному решению владельца от 1 ноября 2026 product candidate `P`
остаётся единственным product SHA в основном launch result с обычным
`mutationsEnabled=false` и `aromaSandbox=null`. Только rollback получает отдельную
проверочную историю конфигурации:

1. `B` имеет единственного родителя `P`; единственное изменение —
   `config/platform.yaml.services.aroma-convergence.mutationsEnabled: false → true`.
   Policy остаётся `null`.

2. `D` имеет единственного родителя `B`. Его diff меняет только
   `config/platform.yaml.services.aroma-convergence.mutationsEnabled: true → false`.
3. `R` имеет единственного родителя `D`. Его config побайтно совпадает с `B`.
   Остальные tracked файлы во всех четырёх commits побайтно одинаковы.

Runner обязан проверять ancestry и полные Git trees/diffs, запретить merge
commits, дополнительные файлы/поля и одновременно staged/unstaged overrides.
Все четыре дерева должны быть clean. Diff проверяется как на уровне полного файла,
так и canonical parsed config: единственное различие `B → D` — указанный boolean.
Для каждого состояния сохраняются commit, parent, tree, config SHA-256 и runtime
receipt. Images, lockfile, pins, code, миграции и encrypted inventory не меняются.
Context, sealed bundle и runtime image IDs связываются с проверенным supply_chain parent
`P`; подмена или копирование supply_chain receipt для `B` запрещены.
Config берётся из соответствующего проверенного checkout по canonical пути;
env overlay, второй service config и подмена основного candidate SHA запрещены.

Эти commits локальные, относятся только к isolated run и не разрешают GitHub
publication, production deployment или новые provider mutations. Перезапуск
затрагивает только run-owned `aroma-convergence`; остальные health/state checks
и все гарантии `rollback` сохраняются. Возврат `R` требует fresh GET и отсутствие blind
replay старого operationRef. Смена config сама по себе не доказывает PASS.

`verification/launch/v1/scenarios/rollback.mjs` проверяет Git lineage и запускает
runtime сценарий через существующий recovery-proof Compose harness. Отдельный
helper `tools/rollback-runtime-proof.mjs` подготавливает owner fixture и сверяет
сохранность durable history. Поставщик в этом сценарии локальный synthetic;
живой AROMA не вызывается. Подтверждаются реальный UnknownOutcome, восстановление
без replay старого operationRef при D, отсутствие новых unsafe вызовов и fresh
wake/verification после R. Health и config mounts проверяются фактически.

Admission отклоняет отсутствующий или некорректный runtime receipt и любой
незавершённый cleanup. Дочерний процесс завершается и присоединяется до удаления
D/R checkouts. Ошибка сохраняет finite stage/code и hash сообщения, без raw
child output. Первый actual run `20261024T110000Z-2fc5704` завершился FAIL;
прежний wrapper потерял внутреннюю причину, поэтому она остаётся NOT_PROVEN.
Все его временные Docker resources удалены. Исправленная диагностика требует
нового run-id; static tests и правильная lineage не являются runtime PASS.

Product parent `P` сохраняет обычные defaults во время и после эксперимента.
Child cleanup и восстановление принадлежащих ему ресурсов фиксируются отдельно;
неизвестное состояние запрещает PASS. [Согласованные границы](../../evidence/launch-preparation/2026-11-01/controlled-config-lineage.md)
не увеличивают таймаут rollback 1800 секунд или main 7200 секунд и не разрешают
живые provider mutations. Прежние failed runs сохраняются.
