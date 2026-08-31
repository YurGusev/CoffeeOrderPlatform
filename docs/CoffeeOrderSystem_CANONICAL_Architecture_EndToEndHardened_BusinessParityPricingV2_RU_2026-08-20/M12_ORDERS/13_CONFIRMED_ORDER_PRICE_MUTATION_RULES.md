# Confirmed Order price mutation rules

До Checkout Freeze разрешены специальные commands add/change/remove/replace.

Если изменяется состав/количество:

- новая/заменённая линия получает fresh PricingQuote;
- изменившаяся customer price явно показывается оператору;
- mutation записывает reason/actor/version;
- OrderPriceManifest получает новую version, но не переписывает историю прошлой версии;
- Desired пересчитывается той же транзакцией Orders.

Неизменённые линии сохраняют locked price snapshot.

После Checkout Freeze нормальная price/content mutation запрещена; используется новый linked Order или compensation.
