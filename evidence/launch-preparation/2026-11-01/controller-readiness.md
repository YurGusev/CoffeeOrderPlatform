# Проверка запуска контроллера и отказа G16

Два исправления подготовлены по замечаниям к PR #249: [запуск контроллера](https://github.com/YurGusev/CoffeeOrderPlatform/pull/249#discussion_r4434854254) и [сохранение отказа G16](https://github.com/YurGusev/CoffeeOrderPlatform/pull/249#discussion_r4434854260). Проверенный набор состоит из parent Source `5cb6e893b80e3e233e9967aa2a6d9ade14762f59` и пяти локальных изменённых файлов. Он не обозначает будущий commit SHA:

- `tools/compose-smoke.mjs`: `c784388b1ff5a9f618b58197494a12d25c2c889a6b9a7fcf8a7259fcc28ab1a5`.
- `tools/runtime-image-inventory.mjs`: `e880bbe0c7560fe44758d5c921d5f40b654c5dd27135b70883a10381c57cc0f1`.
- `verification/launch/v1/run.mjs`: `5f19d5e302c7233676f6b0002a8471f39fd776bafd2fced2ad183a058402ee18`.
- `verification/launch/v1/runner.test.mjs`: `f94a0aead7bed89b75141459f4b787730581a916cf0f1f1b0cf95da5a5d6cc32`.
- `verification/launch/v1/scenarios/aroma-sandbox.mjs`: `5667cdb9c0cc1244b58ad610536c28de8aed517622796a7d2dc518a77675a6d9`.

Контроллер больше не загружает владельческие runtime-модули только ради перечисления образов. Проверка настоящего CLI в изолированном Git checkout с установленными зависимостями и скомпилированным platform-config, но без остальных service dist, дошла до проверки границы доверия: PASS 1/1. Docker и SQL в этой проверке не запускались. Четыре существующие проверки владения образами также прошли; positive и ограничения точных image ID сохранены.

При ненулевом exit контролируемого G16 child родитель сохраняет failure receipt с правами `0600` до передачи FAIL. Подтверждённые child run/SHA, policy/account, идентификаторы оставленных ресурсов и частичные результаты фаз проходят ограниченную проверку и sanitization. Повреждённый, чужой или неподтверждённый результат даёт минимальный FAIL без доверия сведениям; stdout, stderr и произвольные секретные поля не копируются. Проверка использовала настоящий stub child с exit 1 и существующий managed child path, без provider, PostgreSQL, Docker или signer. Это не успешный G16.

Весь существующий `verification/launch/v1/runner.test.mjs` прошёл: 91/91, ошибок и пропусков нет, 116,859 с по wall clock; длительность Node test runner 116,775 с. SHA-256 приватного raw log: `4c781681c8047bceb921c9862954cf918376fd062e2382b97bd77e36102237d5`. Проверки относятся к указанному parent и локальным файлам, не к ещё не созданному commit.

Компонентный G12 Source `5cb6e89`, run `20261101T114056Z-5cb6e89`, остановлен по запросу владельца из-за необходимости исправить оба замечания: `FAIL/INTERRUPTED`, 326,036 с, 10 частичных отчётов; guard не сработал, ошибок cleanup не зафиксировано. SHA-256 приватного cleanup receipt: `e295ed9452b0cc4c000ff68b8715e7a0f1d73f38e01edf7cb14a2a866052e646`. Это не G12 PASS; локальная проверка очистки не доказывает отсутствие незавершённой работы демона BuildKit.

Более ранний G12 Source `883c207` прошёл только как компонент за 1696,201 с; последующая qualification завершилась FAIL до нагрузки, `durationMs=0`. Эти результаты не переносятся на новый Source. Окончательному замороженному candidate нужны собственные CI, G12, SSE qualification и полный G00–G19. Runtime G16 и полный запуск для текущего набора не выполнялись; лимиты и границы provider не менялись.
