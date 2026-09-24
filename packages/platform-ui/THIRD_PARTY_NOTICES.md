# Уведомления о сторонних компонентах

## Inter Variable and Manrope Variable

Локальные variable-font активы входят в выбранный прототип v1.1.0
(CoffeeOrderPlatform commit `2aa6644c9c042c7b722702e6cde31324a4057bb9`).
Исходный presentation revision: `3d4b30b1eaac14c77f41d8779f5e03c54cfacbef`.
Размеры и SHA-256 сверяются в `apps/web/test/ui-foundation.spec.ts` с
`src/styles/fonts/prototype-font-manifest.json`.

Оба семейства распространяются по SIL Open Font License 1.1. Полные оригинальные
тексты лицензий сохранены в `src/styles/fonts/Inter-OFL.txt` и
`src/styles/fonts/Manrope-OFL.txt`.

## shadcn/ui React Aria registry

React Aria-compatible registry скопирован с неизменяемой ревизии:

<https://github.com/shadcn-ui/ui/tree/3ba91b1cc83e1bbe4ab35a422ff2a694849c5048>

Снимки исходников сохранены в `provenance/shadcn/aria/` и адаптированы в
production components. Пути upstream и SHA-256 исходников:

| Локальный снимок | Upstream path | SHA-256 |
| --- | --- | --- |
| `provenance/shadcn/aria/button.tsx` | `apps/v4/registry/bases/aria/ui/button.tsx` | `8bcff6f70522e6e6cb0ff67f050830ea1a93596403d2d9b035f3b543c7a42e2c` |
| `provenance/shadcn/aria/dialog.tsx` | `apps/v4/registry/bases/aria/ui/dialog.tsx` | `ff8a8e6b372e7eb06c931975d8ac1ea59d9271051ac178a62c95f6acae20bb35` |
| `provenance/shadcn/aria/field.tsx` | `apps/v4/registry/bases/aria/ui/field.tsx` | `1019104c41eaef8ffae109e2ece95be87a7a637e3a9bac049d7a9fb54bfb7275` |
| `provenance/shadcn/aria/input.tsx` | `apps/v4/registry/bases/aria/ui/input.tsx` | `b9596748b7238b5605f558474e9d50afc1535c5832c57134055e4bbde5fa804f` |

Локальные адаптации: `Button` сохраняет React Aria primitive и композицию `cn`,
но сопоставляет variants/sizes с API платформы и выбранными tokens; `Dialog`
добавляет controlled/uncontrolled state, защиту закрытия при dirty/pending,
initial/return focus refs и ограниченную прокрутку; `Field` сохраняет нативные
`isInvalid` и input-ref; `Input` оборачивает нативный input внутри пакета.
CVA, shadcn CLI и runtime imports registry исключены.

Оригинальное MIT-уведомление upstream registry (без перевода):

Copyright (c) 2023-present shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Узкий type-only patch React Spectrum

Закреплённый `react-aria-components@1.21.1` транзитивно использует
`@react-types/shared@3.36.1` из React Spectrum revision
`5ecb3333001313e83898cd07644227897e3bae1f5`:

<https://github.com/adobe/react-spectrum/tree/5ecb3333001313e83898cd07644227897e3bae1f5/packages/@react-types/shared>

Пакет лицензирован по Apache-2.0. Единственный pnpm patch
`patches/@react-types__shared@3.36.1.patch` задаёт `string | undefined` для
шести optional ARIA/DOM properties: это требуется при закреплённом TypeScript 7
с `exactOptionalPropertyTypes`. Узкое исключение #137 зафиксировано в ADR-0027;
runtime framework code не меняется, общего разрешения на framework patches нет.
SHA-256 patch:
`6d2be2fb416b65bc3a4aafe22d74cefc9b9b51cbb486031b96d70cd089a5bcfd`.
