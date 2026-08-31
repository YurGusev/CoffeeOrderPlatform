# CoffeeOrderSystem — EndToEndHardened / BusinessParity + Pricing v2

**Дата ревизии:** 2026-08-20  
**Базовая каноническая ревизия:** `CoffeeOrderSystem_CANONICAL_Architecture_EndToEndHardened_WithAgentSkills_API_RU_2026-08-19.zip`  
**SHA-256 базовой ревизии:** `e869535c9c5c0f19d84ff1d2582bd541c4ed1781c44fa5d49836be85235f37f5`

Эта сборка — **каноническая revision-overlay** поверх точно зафиксированной EndToEndHardened-архитектуры. Она не пытается восстановить неизменённые 16k+ строк baseline из памяти: вместо этого задаёт точные нормативные добавления и замены. Если правило этой ревизии конфликтует с baseline, действует эта ревизия. Если файл/правило не затронут — действует baseline.

## Что исправлено

1. Формализована реальная бизнес-логика Customer/duplicate resolution/channel evidence.
2. Добавлены Excel import Preview→Review→Commit и Order Forms/exports.
3. Work Center выделен в отдельную программу `M21_OPERATOR_WORK_CENTER`.
4. Catalog Search/Resolution оформлен как Catalog-owned поддомен, включая aliases/vector/reranker/feedback/abstention.
5. Manual Invoice/PDF recovery path сохранён как first-class бизнес-процесс.
6. Hermes migration теперь обязана переносить policy layer старых AI/AiOrdering, а не только tool loop.
7. VK media/voice/keyboard/carousel и LongPoll→Callback overlap включены в target.
8. Расширены privacy/retention/erasure и Identity/session/bootstrap contracts.
9. Добавлен characterization corpus с `PRESERVE`, `INTENTIONAL_CHANGE`, `RETIRE`.
10. Добавлена программа `M22_PRICING` с полным автоматизированным жизненным циклом цены.
11. Расширены Kafka, service graph, API и runtime topology для Pricing, Import/Export, Customer и Work Center.
12. Зафиксирован repository-security/decommission gate: leaked secret, vendored virtualenv и unsafe bootstrap/refresh semantics нельзя переносить.

## Ключевое бизнес-решение Pricing v2

```text
AROMA list price
   ↓
Supplier discount resolution
   ↓
Supplier net price
   ↓
Delivery coefficient
   ↓
Landed unit cost
   ↓
Markup
   ↓
Final customer unit price
   ↓
Order line total / Order total
```

- Стандартная скидка: **30%**.
- Если AROMA публикует специальную скидку для товара/offer, она **заменяет** 30%, даже если равна 10%.
- Скидки **не складываются**.
- Нормальная наценка: **5, 6, 7, 8, 9, 10%**.
- Начальный delivery coefficient: **1.3%**.
- После завершения поставки оператор вводит фактическую доставку; коэффициент вычисляется по фактической стоимости товаров и активируется **для следующего закупочного цикла**.
- Confirmed-заказ хранит неизменяемый customer-price snapshot. Фактический supplier invoice и фактическая доставка уточняют себестоимость/маржу, но не переписывают уже согласованную клиентскую цену.

## Новые программы

- `M21_OPERATOR_WORK_CENTER`
- `M22_PRICING`

Итого после ревизии: **23 программы (`M00…M22`)**.
