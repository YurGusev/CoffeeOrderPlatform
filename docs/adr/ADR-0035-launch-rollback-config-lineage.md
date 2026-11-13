# ADR-0035: отдельная история config для гейта `rollback`

Статус: решение принято владельцем 24 октября 2026; lineage и runtime сценарий реализованы, runtime PASS пока не получен.<br>
Основание: явное разрешение на config-only commits для `rollback` в ходе #13.

## Контекст

Один clean candidate SHA должен определять продукт, зависимости и миграции всего
launch run. `aroma_sandbox` требует versioned `mutationsEnabled=true`, а `rollback` проверяет
committed переключение в `false` и возврат исходного config digest. Оба состояния
одного tracked файла не могут одновременно принадлежать одному commit.

## Решение

Product candidate `B` остаётся единственным SHA в основном launch result.
Только гейт `rollback` получает два отдельных проверочных config commits:

1. `D` имеет единственного родителя `B`. Его diff меняет только
   `config/platform.yaml.services.aroma-convergence.mutationsEnabled: true → false`.
2. `R` имеет единственного родителя `D`. Его config побайтно совпадает с `B`.
   Остальные tracked файлы во всех трёх commits побайтно одинаковы.

Runner обязан проверять ancestry и полные Git trees/diffs, запретить merge
commits, дополнительные файлы/поля и одновременно staged/unstaged overrides.
Все три дерева должны быть clean. Diff проверяется как на уровне полного файла,
так и canonical parsed config: единственное различие `B → D` — указанный boolean.
Для каждого состояния сохраняются commit, parent, tree, config SHA-256 и runtime
receipt. Images, lockfile, pins, code, миграции и encrypted inventory не меняются.
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

После завершения всего эксперимента рабочая область возвращается к обычным
defaults `mutationsEnabled=false`, `aromaSandbox=null`. Этот cleanup не подменяет
ни `B`, ни результаты его проверки и фиксируется отдельно.
