# `@coffee-platform/ui`

Бизнес-нейтральные primitives интерфейса оператора. React Aria отвечает за
семантику, клавиатуру и focus; Tailwind CSS v4 — за стили и tokens.

Пакет не импортирует маршруты приложения, transport, Query, Effect, API-контракты,
generated DTO, runtime-пакеты, клиентов провайдера и browser network APIs.
Экраны приложения и композиция server state принадлежат #9.

## Публичный API

Публичная поверхность ограничена `Button`, `Link`, `Dialog`, `Field`, `Input`,
`Alert`, `Badge`, `Loading`, `Empty` и собственными inline SVG-иконками.

- `Button`: `variant` — `primary | secondary | danger | quiet`; `size` —
  `compact | default | touch`; `isPending` показывает pending-состояние React
  Aria; `ref` указывает на нативную кнопку.
- `Field`: `isInvalid` не зависит от `errorMessage`; `ref` указывает на нативный
  input и позволяет сфокусировать первое невалидное поле.
- `Input`: собственная оболочка React Aria input с тем же контрактом нативного `ref`.
- `Dialog`: управляемый (`isOpen`) и неуправляемый (`defaultOpen`) режимы.
  Закрытие по клику снаружи требует `isDismissable`; Escape можно отключить через
  `isKeyboardDismissDisabled`. `onRequestClose` вправе отклонить закрытие по
  `escape`, `outside` или явному `action`, если есть несохранённый ввод или pending
  command. `initialFocusRef` и `returnFocusRef` задают focus policy; модальная
  поверхность ограничена по размеру и прокручивается на узких экранах.

## Сборка пакета и browser

Из корня репозитория:

```sh
pnpm --filter @coffee-platform/ui build
pnpm web:build
pnpm dev:browser
```

`dev:browser` запускает Vite browser shell. Отдельный Node runtime для `web`
удалён: browser bundle из `apps/web/dist/browser` входит в native nginx image.
Generated `dist` — только локальный результат проверки, его не коммитить.

Стили пакета экспортируются как `@coffee-platform/ui/styles.css`: tokens
выбранного прототипа v1.1.0 адаптированы к Tailwind CSS v4 и границам React Aria.
Inter Variable используется для основного текста, Manrope Variable — для
заголовков. Оба шрифта хранятся локально в `src/styles/fonts/`; внешний font CDN
и сетевой запрос не нужны. Source commits, размеры и SHA-256 активов указаны в
`src/styles/fonts/prototype-font-manifest.json`; лицензии лежат рядом со шрифтами.

От прототипа взяты только presentation tokens, типографика и визуальное направление
shell. Fixture-реестр счетов, legacy runtime, routes и API не включены в пакет
или production browser shell.

## Происхождение

Снимки исходников shadcn/ui React Aria и локальные адаптации описаны в
`provenance/shadcn/` и `THIRD_PARTY_NOTICES.md`. Каталог provenance не входит
в runtime build.

## Узкое исключение совместимости TypeScript 7

Зафиксированный `react-aria-components@1.21.1` пока требует type-only patch
declarations `@react-types/shared@3.36.1` из `THIRD_PARTY_NOTICES.md` и ADR-0027.
Исключение #137 касается только шести optional ARIA/DOM properties: runtime
framework code не изменяется, `skipLibCheck` не допускается. Patch нужно удалить
после появления совместимых upstream declarations для закреплённого TypeScript 7.
