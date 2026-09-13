# Evidence исправления контрактных ограничений issue #10

Статус: `local-contract-correction-verified`; merge и полное acceptance issue #10 не одобрены.

## Основание

До подключения production cart/export/mutation routes устранены два расхождения между контрактной семантикой и source schemas. Остаточное ревью URI grammar дополнительно показало, что первый strict pattern всё ещё ошибочно принимал `1:abc`, `:abc` и `/[::1]`:

1. RFC 9457 задаёт `ProblemDetails.type` и `ProblemDetails.instance` как URI-reference. Одного `URL.canParse` недостаточно: WHATWG parser нормализует некоторые запрещённые RFC 3986 символы вместо отказа. Исправленная RFC 3986 grammar запрещает colon в первом сегменте relative-path и допускает bracketed IP literal только после `//` authority marker.
2. `SetLineQuantity` принимает только положительное количество; ноль выражается отдельной операцией `RemoveLine`. Provider-specific maximum, scale и step не определяются этим исправлением.

## Exact narrowing evidence

| Location | Изменение | Negative fixture |
|---|---|---|
| `ProblemDetails.instance.format` | отсутствовал → `uri-reference` | `invalid-problem-instance` |
| `ProblemDetails.instance.pattern` | отсутствовал → strict RFC 3986 URI-reference syntax | `invalid-problem-instance-space` |
| `ProblemDetails.type.pattern` | отсутствовал → strict RFC 3986 URI-reference syntax | `invalid-problem-type-space` |
| `ProviderQuantity.pattern` | zero-or-positive → strictly positive | `zero-provider-quantity` |

Canonical SHA-256 нового JSON-encoded URI-reference pattern: `8c8663bb9fd47e36644c511ad4f843e5945c88aa01d29681f781949b8a69b979`. Одинаковый pattern используется standalone `contractAjv`, обоими полями `ProblemDetails` и generated `isAromaProblem`; отдельный ручной validator не добавлен.

`contracts:breaking` принимает каждое narrowing только при точном совпадении location/keyword/before/after и автоматически проверяет named fixture:

- прежнее ограничение принимает fixture value;
- новое ограничение отклоняет то же значение;
- ошибка относится к заявленному keyword.

Иной pattern/format, отсутствующий pointer, неподходящий fixture или fixture, который остаётся допустимым после изменения, сохраняет fail-closed результат breaking guard.

## Compatibility boundary

- Invalid URI-reference не является нормативно допустимым RFC 9457 значением; исправление запрещает ранее ошибочно принятые bytes.
- Production AROMA set/remove route ещё не подключён, поэтому positive-only Set закрепляется до появления runtime callers.
- Existing Unicode semantics не меняются: `title: "😀".repeat(101)` остаётся допустимым, поскольку `maxLength` применяется к Unicode code points.
- Provider endpoint semantics, quantity scale/max/step, login/session и cart identity этим evidence не подтверждаются.

## Наблюдаемая проверка остаточного URI review

- RED до grammar fix: `node --test tests/contracts/schemas.test.mjs` — exit `1`, `5 pass`, `2 fail`; оба failing assertions вернули `["1:abc", ":abc", "/[::1]"]` вместо пустого списка.
- GREEN после fix: та же команда — exit `0`, `7 pass`, `0 fail`; `node --test tests/contracts/openapi-fixtures.test.mjs` — exit `0`, `8 pass`.
- Финальный `pnpm contracts:test` — `39 pass`, `0 fail/skipped`; `pnpm contracts:breaking` и `node --test tests/contracts/breaking.test.mjs` — exit `0`, отдельный suite `18/18 pass`.
- `pnpm contracts:check-generated` подтвердил byte-identical aggregate SHA-256 `1f87e9631e953d80f3e303fb880362543dc4cf2db6296649fec897a6e64c86f5`.
- Negative corpus: `1:abc`, `:abc`, `/[::1]`, `http://[`, whitespace, backslash, malformed percent encoding, NUL, malformed brackets и quote.
- Positive corpus: `./1:abc`, `/a:b`, `//[::1]/`, `http://[::1]/`, `HTTP://EXAMPLE.COM/problem`, `urn:example:test`, `/relative/path`, `../a?b#c`, `a%20b`.

AROMA/provider не вызывался. Commit, push, PR и merge не выполнялись.
