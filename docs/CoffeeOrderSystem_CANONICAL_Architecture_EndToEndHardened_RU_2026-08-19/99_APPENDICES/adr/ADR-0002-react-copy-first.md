# ADR-0002: React переносится copy-first, а не переписывается

**Status:** Accepted target

## Решение

`src/CoffeeOrderSystem.Web` копируется в `platform/apps/web`, проходит exact build/E2E parity и затем становится canonical frontend.

Главная техническая переработка до cutover — отвязать OpenAPI generation от ASP.NET `obj/` и использовать versioned language-neutral contract artifact.

## Hosting

На первом этапе сохранить текущий build pattern: Node build stage + internal Nginx static runtime. SSR/Node server только отдельным ADR.
