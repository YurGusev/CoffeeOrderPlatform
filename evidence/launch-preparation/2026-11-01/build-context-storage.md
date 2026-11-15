# Размещение build context

Статус: устранение измеренного различия входных данных сборки.
Полные G12, SSE qualification и G00–G19 окончательного SHA ещё обязательны.

## Отрицательное доказательство

Standalone G12 `20261101T080816Z-4777695` завершился PASS за 840,099 с:
46 отчётов, 22 образа, 0 unresolved HIGH / CRITICAL, собственный cleanup PASS.
SHA result:
`cd1d8d2abfeef7fd24b80a991e438410656550145e52c75358066e23c51de0be`.
Независимое ревью проверило все 59 артефактов.

Следующая qualification `i12-6de2a2cb04184272` завершилась FAIL через
423,869 с до измерения нагрузки (`durationMs=0`). Строгое сравнение IDs
отклонило восстановленный edge-gateway:

- G12: `sha256:37955d0e5def1e5ba696b99aa7ec013fba287cb2e49c1ad4f266f93eb478969f`;
- runtime: `sha256:a64578a8e1d519fec159ce1bdb39bc7c94613e2c7ab959b533e6a1a1590fbbf2`.

Отличались все четыре восстанавливаемых образа. Сверка оставлена строгой.
Контейнеры и сеть ещё не создавались. Синтетическая private materialization
и четыре собственных тега удалены после диагностики; исходные FAIL и
`cleanupVerified=false` не переписаны. Дочерний checkout сохранён целиком
вне parent с Git-историей. Отдельный manual cleanup PASS имеет SHA
`de9b48a54cdc26e38885c2964bd58482d45b309843671e836df12c1d30c8505c`.

## Установленная причина

При переносе объёмного scratch на NTFS туда попал и небольшой build context.
Canonical runtime-сборка использовала исходный `/tmp` на ext4.

У обоих snapshot совпали Git archive SHA
`36f246aefd37a9072927e4c47cbed07ed45f3b376a84deafcf57d3d6b59acb9b`,
extracted tree SHA
`c7f9657621a102240a95de2676e7ee5e9f945fe412bfef6702b22884128b479c`,
байты файлов, mode, UID/GID и mtime. Различие прав не подтвердилось.
Но реальные source patch, platform config, nginx snippet и каталоги на NTFS
несли дополнительные `$LXUID/$LXGID/$LXMOD`; на ext4 xattrs отсутствовали.
Эти атрибуты не входят в прежний hash дерева, но участвуют в checksum
BuildKit. SHA парного доказательства xattrs:
`743cedcf8ce75055cfef16505daaadbea5a63dd8472597cbe909c3bdd63d02e1`.

Builder, Dockerfile frontend, base materials, platform и нормализованные
LLB-инструкции совпали. У Node совпали base/apk/native слои, отличались
конечные COPY-слои; у nginx отличались только два COPY со snippets.
Первое расхождение cache hit видно на source COPY, затем повторялась
дорогая native/TypeScript сборка.

Один разделяющий эксперимент использовал те же OCI-export args G12,
но snapshot на ext4. За 22,006 с получен точный canonical ID `a64578…`.
Таким образом, формат OCI против `--load` не объясняет это расхождение;
оно воспроизводится при смене файловой системы build context.
Diagnostic SHA:
`e00995cd4ed10e25540114bfd772ec1163f0c54be15f2669e5b34736c5b6d7a0`.
Собственные snapshot/layout удалены, новый тег в Docker image store
не появился; root и builder guards соблюдены.

Механизм сверён с точным
[BuildKit 0.32.2 filehash](https://github.com/moby/buildkit/blob/v0.32.2/cache/contenthash/filehash.go#L54),
[правилами COPY cache](https://docs.docker.com/build/cache/invalidation/)
и [документацией NTFS3](https://docs.kernel.org/filesystems/ntfs3.html).

## Исправление

Git archive и извлечённый build context G12 создаются отдельным собственным
временным каталогом в исходном `tmpdir()`, как в canonical runtime pipeline.
Для этого сервера это `/tmp` на ext4. Основной DB/OCI scratch остаётся
на выбранном внешнем хранилище. Это возвращает source input в одинаковую
среду без отключения проверки IDs или удаления атрибутов пользовательских
файлов. Дополнительный объём root — около 73 MB для archive и исходников.

Собственный source temporary удаляется в общем finally при PASS/FAIL;
ошибка удаления остаётся blocking cleanup failure. Другие callers snapshot,
DTO/schema, config/BOM, CVE/VEX, scanner lock и лимиты не меняются.
Глобальный xattr framework, новый image cache и повторная реализация
import/promotion не добавляются.

## Проверки исходников

Под общим heavy lock, Node 26.8.1 и `umask 022` существующий
`node --test tests/tools/security-scan.test.mjs` прошёл 17/17 за 37,715 с.
Регрессия проверяет archive/context в исходном tmpdir, DB/OCI во внешнем
scratch, исходный scanner lock, cleanup при PASS, позднем FAIL и SIGTERM,
а также blocking `TEMP_CLEANUP_FAILED` при отказе удаления source snapshot.
Это synthetic Docker fixture; реальные image IDs нового SHA она не доказывает.
SHA журнала:
`0f523607611073c48f08c7c32eca248de0f2ba17730f14e20d5a629402de4127`.

Scoped type-aware Oxlint, Prettier, `node --check` двух файлов и
`git diff --check`: PASS. SHA журнала:
`64baf1a3ca4d99ba54374861757fe3bb15b3e9a57bb691bc7b52db1f1584615d`.
После freeze обязательны собственные CI/G12, реальная сверка четырёх IDs,
SSE qualification и полный ordered G00–G19. Лимиты 1800/7200/2700 с сохранены.
