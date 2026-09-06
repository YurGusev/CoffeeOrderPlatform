---
name: issue-delivery-closure
description: Проверять готовность и завершать delivery issue CoffeeOrderPlatform по фактическому acceptance, чистому scope, handoff и принятому merge. Использовать при аудите галочек, commit/push, создании или merge PR и закрытии issue.
---

# Завершение delivery issue

Этот skill отвечает только за delivery closure. Корректность изменяемой области
проверяет её owning skill.

## Authority и разрешения

Прочитать live issue через GitHub, `AGENTS.md`, delivery graph, predecessor
handoff и owning документы. Перед remote mutation подтвердить точный `origin`,
`gh repo view` и авторизацию. Push, изменение issue/labels, создание или merge PR
выполнять только по явному разрешению пользователя.

## Фактическая готовность

- Проверять отдельно remote branch и локальный working tree. Незакоммиченный или
  неотправленный файл не подтверждает выполненную delivery-галочку.
- Каждая отмеченная галочка обязана подтверждаться фактическим diff, документом,
  тестом или external state. Процессную галочку отмечать только после события.
- Сравнить итоговый diff с `origin/develop`; в нём остаются только файлы текущего
  issue. Чужие и параллельные изменения не staging-ить и не переносить молча.
- Запустить самый узкий локальный набор команд из issue и записать точные команды,
  результаты, пропуски и ограничения. Зелёный результат не компенсирует неверный
  scope или противоречивую документацию.
- Если хотя бы один обязательный пункт не доказан, issue не закрывать: назвать
  минимальное исправление и оставить невыполненные галочки открытыми.

## Handoff

Handoff создаётся по текущему protocol и только из финального diff:

- `baseCommit` — accepted `develop`, от которого создана ветка;
- каждый input содержит accepted predecessor merge commit, artifact и его hash;
- outputs перечисляют только изменённые downstream artifacts с актуальными
  hashes и consumers;
- verification содержит только реально выполненные команды;
- limitations прямо фиксируют непроверенное поведение;
- self commit SHA не добавляется.

После любого изменения output пересчитать hashes. Historical handoff не
переписывать ради нового формата.

## Закрытие

После подтверждения всех acceptance criteria:

1. Закоммитить только scope issue русскоязычным commit и отправить его рабочую
   ветку.
2. Создать один PR в `develop`; body содержит `Closes #<issue>`, точные локальные
   доказательства и limitations.
3. Проверить base/head, соответствие номера branch issue и единственную
   `closingIssuesReferences` на это issue.
4. Merge выполнять только для полного diff и при наличии разрешения пользователя.
5. После merge подтвердить merge commit и закрытое issue. Для каждого
   непосредственного successor проверить все обязательные inputs по
   `docs/launch/13_DELIVERY_DEPENDENCY_GRAPH.md`: accepted merge в `develop` и
   требуемый handoff. Переводить successor из `status:blocked` в `status:ready`
   только после подтверждения всех inputs и при разрешении на изменение labels.
   Иначе сохранять его статус; статусы остальных issues не менять.

Не создавать для closure новые dependencies, status automation, verification
framework или второй handoff format.
