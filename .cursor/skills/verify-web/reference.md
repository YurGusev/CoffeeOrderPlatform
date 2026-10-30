# Справочник прогона apps/web

## Граница

Один процесс Vite из `apps/web` и один чистый Chromium. Команда процесса:

```bash
pnpm --dir apps/web exec vite --config vite.config.ts --host 127.0.0.1 --port <port> --strictPort
```

Это тот же `vite --config vite.config.ts`, что скрипт `dev:browser`.
Скрипт добавляет только хост, порт и `strictPort`, чтобы не занять чужой
порт 5173. `GET /auth/session` этот процесс не обслуживает. Ответ не является
JSON сессии, поэтому `SessionBoundary` показывает «Требуется вход».

Переменная `VERIFY_WEB_RUN` равна run-id и стоит только в окружении этого
процесса. По ней doctor узнаёт владельца порта, а `--down` выбирает, кого
остановить.

## Команда

```bash
node .cursor/skills/verify-web/run.mjs
node .cursor/skills/verify-web/run.mjs --down <run-id>
```

run-id имеет вид `20261030t055800z-ab12cd`.

## Evidence

`evidence/web-verify/` записан в `.gitignore`.

| Файл | Содержимое |
|---|---|
| `result.json` | `status` равен `pass`, `incomplete` или `fail`. Рядом числа `passed`, `failed`, `notCovered` |
| `screenshots/<id>.png` | весь документ после проверки сценария |
| `screenshots/<id>.aria.txt` | ARIA-снимок `main` |
| `doctor.json` | `origin`, `httpStatus`, `titleFound`, `portOwned`, `ok` |
| `run.json` | `runId`, `pid`, `port`, `origin`, команда Vite |
| `environment.json` | полный commit и флаг `dirty` |
| `vite.log` | stdout и stderr Vite без ANSI-цветов |
| `browser.log` | консоль страницы, `pageerror` и ответы HTTP 400 и выше |

В сценарии со статусом `pass` есть `documentTitle`, `href` и `screenshot`.
В сценарии со статусом `fail` есть `error` и, если страница открылась, `body`.
В сценарии со статусом `not-covered` есть `reason`. Статус `not-run` значит,
что более ранний сценарий или старт уже оборвали прогон.

`pass` пишется одним разом, после всех проверяемых сценариев. До этого
файл содержит `incomplete`.

## Сценарии скрипта

Проверяемые id: `session-root`, `session-customers-closed`,
`session-catalog-closed`, `session-new-order-closed`, `session-order-closed`,
`session-unknown-closed`.

Остальные id в массиве `notCovered` файла `run.mjs` не открывают страницу
фичи. Их число в `result.json` и есть число непокрытых сценариев.

## Как расширять

Новый проверяемый сценарий добавлять в массив `covered` в `run.mjs` и в
файл фичи. Сценарий обязан открыть адрес в том же Chromium, проверить
видимый текст и ссылку, записать png и aria. Не помечать его `pass`, если
вместо экрана фичи виден вход.

Новый непокрытый сценарий добавлять в `notCovered` с причиной, которая
видна из кода, и строку в карту `features/`. Не закрывать пробел моком
`/auth/session` внутри этого рычага.

Следующая граница, когда понадобится доказать экраны за сессией, это
отдельный прогон с живым входом. Его не смешивать с этим Vite-only срезом.
