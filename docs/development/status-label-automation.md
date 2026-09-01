# Автоматические переходы `status:*`

Workflow `.github/workflows/status-labels.yml` поддерживает у связанной задачи
ровно одну статусную метку. Остальные labels задачи сохраняются.

| Событие | Новый status |
|---|---|
| создание `feature/<issue>-<slug>`, `fix/...`, `docs/...` или `test/...` | `status:in-progress` |
| открытие готового к review PR или новый commit в нём | `status:review` |
| draft PR или возврат PR в draft | `status:in-progress` |
| review со сводным решением `APPROVED` | `status:testing` |
| review со сводным решением `CHANGES_REQUESTED` | `status:in-progress` |
| merge PR или закрытие issue | `status:done` |
| закрытие PR без merge | `status:in-progress` |
| повторное открытие issue | `status:ready` |

PR связывается с задачей двумя способами: через номер в имени ветки и через
GitHub closing reference (`Closes #123`, `Fixes #123`, `Resolves #123`). Если
оба способа указывают на разные задачи, workflow обновляет каждую из них.

Workflow выполняется только из trusted revision основной ветки, не checkout-ит
код PR и имеет минимальные права: чтение repository/PR и запись labels issues.
Метки `status:*` должны быть созданы в репозитории заранее.

`status:blocked` снимается только когда начинается фактическая работа над
задачей. Автоматическое вычисление зависимостей между issues в этот workflow не
входит: готовность предшественников остаётся явным решением владельца delivery.

Локальная проверка workflow и переходов запускается без сторонних dependencies:

```bash
node --test tests/github/status-labels.test.mjs
```
