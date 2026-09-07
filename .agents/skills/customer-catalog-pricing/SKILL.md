---
name: customer-catalog-pricing
description: Менять Customer, Catalog и расчёт PricingQuote.
---

# Customer, Catalog и Pricing

Customer владеет identity/contacts/addresses/channel links. Catalog владеет products,
variants, aliases, complete supplier snapshots, mapping, availability, and
search. Pricing owns policy, markup, delivery coefficient, quotes/hashes,
projections и margin. Orders владеет принятыми agreement snapshots.

Catalog sync выполняет безопасные полные чтения через AROMA Gateway. Неполный
снимок закрывается отказом и не удаляет отсутствующий хвост. Интерактивные пути
читают сохранённые снимки. PricingQuote неизменяемая, версионированная,
ограниченная по времени, рассчитанная сервером и хэшируемая. Confirmed Order не
переоценивается незаметно.

Проверять identity/PII, полноту, availability transitions, сохранение mapping,
детерминизм поиска, money/rounding, quote expiry/hash и policy concurrency.
