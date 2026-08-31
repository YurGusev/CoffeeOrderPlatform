# Business parity audit closure

## Статус

Код-аудит `develop@4939a4da2e9483a932c4c2b89b3ba908bbfeee3a` выявил capability gaps поверх EndToEndHardened. Эта ревизия закрывает их **на specification level**.

| Gap | Решение | Статус спецификации |
|---|---|---|
| Customer fuzzy/duplicate/evidence lifecycle | M07 + M09 | CLOSED |
| Pricing/markup provenance | M22 + M12 | CLOSED |
| Excel import preview/commit | M12 + M19 + runtime/Kafka delta | CLOSED |
| Order Forms/export | M12 + runtime/Kafka delta | CLOSED |
| Work Center | новая M21 | CLOSED |
| Catalog Search/Resolution | M07 | CLOSED |
| Invoice manual/recovery | M10 | CLOSED |
| Hermes policy parity | M09 | CLOSED |
| VK media/voice | M09 | CLOSED |
| Privacy/retention | M15 | CLOSED |
| Repository secret/venv/bootstrap/refresh debt | M00/M15/M16 | CLOSED as migration gate |
| Characterization corpus | M16 | CLOSED as specification; evidence pending |

## Что сознательно не сохраняется из legacy

Три pricing behavior признаны ошибочными/устаревшими и имеют disposition `INTENTIONAL_CHANGE`:

1. `max(baseDiscount, productDiscount)` — заменён product/offer override.
2. selectable markup `1–8%` — заменён `5–10%`.
3. изменение customer price после PDF invoice — запрещено после Confirm.

Legacy direct Draft→AROMA, unsafe refresh-token semantics, hard-coded bootstrap password, cross-owner writes и vendored virtualenv имеют disposition `RETIRE`.
