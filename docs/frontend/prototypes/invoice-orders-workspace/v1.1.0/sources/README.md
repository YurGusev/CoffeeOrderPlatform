# Presentation sources

Этот каталог содержит только CSS presentation layer, выбранный из `YurGusev/CoffeeOrderSystem` для воспроизводимого visual reference.

- Repository: `https://github.com/YurGusev/CoffeeOrderSystem`
- Branch: `develop`
- Commit: `3d4b30b1eaac14c77f41d8779f5e03c54cfacbef`
- Scope: tokens, global styles, OperatorShell, AppLogo, Orders workspace/table finite variants и shared UI CSS primitives.

Здесь нет legacy React-компонентов, API, state, DTO, auth или runtime-кода.

`../../source-manifest.json` хранит SHA-256 каждого snapshot. `../../verify-source.mjs` проверяет snapshots, встроенные WOFF2 bytes и наличие namespace markers в `../../exact-source.css` без сети и без `/tmp` clone.

Inter Variable и Manrope Variable взяты из `@fontsource-variable/*@5.3.0`; их WOFF2 bytes встроены data URI в `exact-source.css`, а SHA-256 зафиксированы в manifest.
