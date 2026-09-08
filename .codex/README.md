# Astra и Luna для CoffeeOrderPlatform

Локальная адаптация [donvito/codex-astra-luna-orchestrator](https://github.com/donvito/codex-astra-luna-orchestrator).

| Режим | Astra и reviewer | Luna | Лимит субагентов |
|---|---|---|---|
| Обычный | root — выбор пользователя; reviewer — low | medium | 4 |
| Большой | root — выбор пользователя, reasoning medium; reviewer — Astra medium | high | 8 |

Лимит исключает корневого агента; это потолок, а не обязательное число.
Начинать с одного Luna для содержательной подзадачи; добавлять остальных только
для независимой работы. Для простого изменения субагенты не нужны.

Из корня проекта:

```bash
codex # Модель root из пользовательских настроек
bash .codex/large.sh # Большой
```

Большой запуск принимает аргументы Codex, например:
`bash .codex/large.sh exec 'Описание задачи'`.
Режимы проверены на Codex CLI 0.153.2. Большой запуск задаёт параметры через
CLI overrides, включая отдельный файл reviewer. Глобальные профили для этих
режимов не создаются.
[Документация профилей](https://developers.openai.com/codex/config-advanced/#profiles).

Модель и reasoning root выбираются в Desktop или параметрами запуска.
Проект не закрепляет их; без явного выбора действуют глобальные defaults.
Для схемы с корневым Astra выбери Astra / low; Luna также может быть root. Для воспроизводимого большого
режима использовать команду выше в терминале. Она не переключает открытые задачи
Desktop. Явный выбор модели/reasoning при запуске или spawn имеет приоритет.

Навык `$astra-orchestrator` находится в `.agents/skills/astra-orchestrator`;
после изменения конфигурации агентов использовать новую сессию. Глобальные
настройки не изменяются.
Роли explorer, worker, tester и researcher закреплены на Luna, reasoning
наследуют от agents; reviewer закреплён на Astra с настройкой для каждого режима.
Глобальная luna_worker в проекте использует worker без фиксированного xhigh.

## Передача работы и возврат замечаний

```text
                  GPT-6 Astra
               root / orchestrator
                       |
       +---------------+---------------+
       |               |               |
    explorer         worker        researcher
      Luna            Luna            Luna
       +---------------+---------------+
                       |
                     tester
                      Luna
                       |
                    reviewer
                     Astra
                       |
                  GPT-6 Astra
               integrate + verify
```

Root — основной агент задачи; reviewer — отдельный субагент Astra.
Reviewer сообщает root замечания, рекомендуемую роль и критерии приёмки.
Root организует исправления, tester проверяет их, reviewer повторяет ревью.
Подробные правила — в [навыке оркестратора](../.agents/skills/astra-orchestrator/SKILL.md#цикл-ревью-и-исправлений).
Порядок закреплён в developer_instructions проектного config.toml и навыке.
Стрелки означают передачу результатов через root; дети не запускают детей.
Это порядок работы агентов по инструкциям, а не автоматический CI workflow.

*Merge PR и закрытие issue выполняет root после обязательных проверок и при
явном разрешении пользователя.

## Экономия Astra

Root выполняет краткую первичную проверку и передаёт подробный поиск explorer,
реализацию worker, проверки tester. Внешние источники изучает researcher.
Astra принимает архитектурные решения и результат независимого reviewer;
не повторяет весь поиск, тестовый прогон и ревью без новых оснований.
Точные границы: [правила Codex](../.agents/skills/astra-orchestrator/references/codex.md#границы-и-экономия-astra).
Настройка задаёт поведение, а не жёсткий бюджет токенов и не автоматический
маршрутизатор. Для применения в Desktop открыть новую задачу с Astra / low.
