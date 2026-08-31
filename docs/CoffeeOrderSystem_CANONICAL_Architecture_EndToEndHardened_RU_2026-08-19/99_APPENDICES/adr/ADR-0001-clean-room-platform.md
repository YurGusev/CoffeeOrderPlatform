# ADR-0001: Новая TypeScript platform строится рядом с `src/`

**Status:** Accepted target

## Решение

Создать root-level `platform/` и вести C# `src/` как reference/legacy до bounded-context cutover.

Новая platform не импортирует C# runtime artifacts. Разрешены только language-neutral contracts и behavioral evidence.

## Причины

- не разрушать рабочую систему во время rewrite;
- независимый TS build graph;
- clean-room architecture rules;
- parity testing;
- Nginx strangler migration;
- возможность удалить `src/` после доказанного cutover.
