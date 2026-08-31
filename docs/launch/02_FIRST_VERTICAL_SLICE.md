# Первая вертикаль

## Успешный сценарий

```text
1. React создаёт или выбирает Customer.
2. React ищет товар в сохранённом снимке Catalog.
3. React запрашивает PricingQuote.
4. React создаёт Draft Order с quoteRef/hash и снимком товара.
5. React подтверждает Draft с ожидаемой OrderVersion и Idempotency-Key.
6. Транзакция Orders сохраняет Confirmed, Desired, историю и Outbox.
7. Подготовка Orders проверяет сохранённые факты mapping/availability Catalog.
8. Convergence получает lease/fence и вызывает AROMA Gateway.
9. Gateway выполняет свежий GET, не более одной мутации и свежий GET.
10. Orders сохраняет Observed и результат Convergence.
11. Realtime-инвалидация обновляет Order Card в React.
```

## Состояния, видимые пользователю

Order lifecycle:

```text
Draft -> Confirmed
```

AROMA state is orthogonal:

```text
PendingCatalogProof
PendingObservation
OutOfSync
Converging
InSync
Blocked
UnknownOutcome
```

## Приёмочный сценарий

При полном снимке Catalog и корректном AROMA mapping подтверждение Draft
возвращает HTTP-ответ сразу после локальной транзакции Orders. Затем интерфейс
получает инвалидацию и показывает `InSync`, когда desired и observed quantities
совпадают.

Если ответ на мутацию потерян, интерфейс показывает `UnknownOutcome`. До новой
мутации система обязана выполнить свежее наблюдение. Универсального действия
«отправить ещё раз» у оператора нет.
