# syntax=docker/dockerfile:1.9

# The digest is deliberately repeated for the build and runtime stages.  This
# keeps the image identity immutable and makes a builder/runtime drift fail in
# review instead of silently selecting another Node release.
ARG NODE_IMAGE=node:26.8.1-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3
# The scanner supplies the exact pinned base only for the Kafka target. The
# inert default keeps unrelated targets parseable without enabling a fallback.
ARG KAFKA_IMAGE=scratch
ARG GRAFANA_IMAGE=scratch
ARG KEYCLOAK_DISTRIBUTION_IMAGE=scratch
ARG KEYCLOAK_RUNTIME_IMAGE=scratch

FROM ${NODE_IMAGE} AS librdkafka-build

ARG LIBRDKAFKA_VERSION=2.15.0
ARG LIBRDKAFKA_SOURCE_SHA256=259015220cdca708afe838b5aa79ebf1a5fb710fb4179cf918d390aed85d5dbc
ENV JOBS=4
ENV MAKEFLAGS=-j4

WORKDIR /source

RUN --network=host apk add --no-cache --upgrade bash ca-certificates curl gcc g++ make pkgconf openssl-dev zlib-dev zstd-dev lz4-dev cyrus-sasl-dev curl-dev \
  && curl --fail --location --retry 3 --output librdkafka.tar.gz "https://github.com/confluentinc/librdkafka/archive/refs/tags/v${LIBRDKAFKA_VERSION}.tar.gz" \
  && echo "${LIBRDKAFKA_SOURCE_SHA256}  librdkafka.tar.gz" | sha256sum -c - \
  && tar --extract --gzip --file librdkafka.tar.gz --strip-components=1 \
  && ./configure --prefix=/usr/local \
  && make -j4 \
  && make install \
  && test "$(PKG_CONFIG_PATH=/usr/local/lib/pkgconfig pkg-config --modversion rdkafka)" = "${LIBRDKAFKA_VERSION}" \
  && test -f /usr/local/lib/librdkafka.so \
  && test -f /usr/local/lib/librdkafka++.so

COPY patches/librdkafka-resume-wakeup.patch config/toolchain-versions.json /source/
RUN --network=host apk add --no-cache patch \
  && node -e "const fs=require('node:fs'),crypto=require('node:crypto');if(crypto.createHash('sha256').update(fs.readFileSync('librdkafka-resume-wakeup.patch')).digest('hex')!==require('./toolchain-versions.json').librdkafkaPatchSha256)throw Error('LIBRDKAFKA_PATCH_HASH_MISMATCH')" \
  && patch --batch --forward --fuzz=0 --strip=1 --input=librdkafka-resume-wakeup.patch \
  && make -j4 \
  && make install \
  && test "$(PKG_CONFIG_PATH=/usr/local/lib/pkgconfig pkg-config --modversion rdkafka)" = "${LIBRDKAFKA_VERSION}"

# Сохраняем пути workspace manifests без списка всех сервисов в Dockerfile.
# Изменение исходников повторяет только этот дешёвый шаг; его выход неизменен.
FROM ${NODE_IMAGE} AS workspace-manifests
WORKDIR /workspace
RUN --mount=type=bind,source=package.json,target=/package.json,readonly \
    mkdir -p /manifests \
    && node -e 'const fs=require("node:fs"),input=process.argv[1],output=process.argv[2],manifest=JSON.parse(fs.readFileSync(input,"utf8"));delete manifest.scripts;fs.writeFileSync(output,`${JSON.stringify(manifest)}\n`)' /package.json /manifests/package.json
RUN --mount=type=bind,source=apps,target=apps \
    --mount=type=bind,source=packages,target=packages \
    cp --parents apps/*/package.json packages/*/package.json packages/contracts/*/package.json packages/generated/*/package.json /manifests/

FROM ${NODE_IMAGE} AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV LIBRARY_PATH=/usr/local/lib
ENV LD_LIBRARY_PATH=/usr/local/lib
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig

WORKDIR /workspace

RUN --network=host apk add --no-cache --upgrade ca-certificates python3 make g++ pkgconf libcrypto3 libssl3 zlib zstd-libs lz4-libs libsasl libcurl

COPY --from=librdkafka-build /usr/local/include/librdkafka /usr/local/include/librdkafka
COPY --from=librdkafka-build /usr/local/lib/librdkafka.so* /usr/local/lib/
COPY --from=librdkafka-build /usr/local/lib/librdkafka++.so* /usr/local/lib/
COPY --from=librdkafka-build /usr/local/lib/pkgconfig/rdkafka*.pc /usr/local/lib/pkgconfig/

# node-gyp reads JOBS directly. MAKEFLAGS propagates the same bounded jobserver
# to nested OpenSSL and librdkafka builds.
ENV JOBS=4
ENV MAKEFLAGS=-j4

RUN --network=host npm install --global --no-fund --no-audit corepack@0.35.0 \
  && corepack enable \
  && corepack prepare pnpm@11.24.0 --activate

# Только входы установки влияют на кэш зависимостей и native addon.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --from=workspace-manifests /manifests/ ./

# Node 26 has no Confluent 1.10.0 prebuilt addon. Keep pnpm lifecycle scripts
# disabled and perform the native build as an explicit supply-chain step. The
# upstream documented flags link only the addon against the separately pinned
# librdkafka stage, avoiding the bundled static archive and pnpm scoped path.
# Заголовки того же закреплённого Node-образа исключают повторную загрузку из сети.
RUN --network=host pnpm install --frozen-lockfile --ignore-scripts \
  && cd node_modules/@confluentinc/kafka-javascript \
  && CKJS_LINKING=dynamic BUILD_LIBRDKAFKA=0 node ../../@mapbox/node-pre-gyp/bin/node-pre-gyp rebuild --nodedir=/usr/local \
  && cd /workspace \
  && ldd node_modules/@confluentinc/kafka-javascript/build/Release/confluent-kafka-javascript.node | grep -F '/usr/local/lib/librdkafka.so.1'

# Restore root scripts only after dependency installation and native compilation
# so scripts-only aliases do not invalidate those expensive layers.
COPY package.json ./

COPY tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY types ./types
# Keep mutable runtime config out of the shared compile/deploy cache.
COPY config/node26-compatibility-matrix.json \
  config/node26-compatibility-matrix.schema.json \
  config/toolchain-versions.json ./config/
COPY scripts/check-node26-compatibility.mjs ./scripts/check-node26-compatibility.mjs

RUN node scripts/check-node26-compatibility.mjs \
  && pnpm exec tsc -b packages/platform-runtime/tsconfig.json --pretty false \
  && pnpm typecheck

# Runtime selection must not invalidate dependency installation, native addon
# compilation or the common typecheck when Compose materializes all 14 Node images.
ARG RUNTIME=edge-gateway
# Явное копирование ускоряет deploy на файловой системе builder, сохраняя /runtime.
RUN test "${RUNTIME}" != "web" && pnpm --filter "@coffee-platform/${RUNTIME}" deploy --prod --legacy --package-import-method=copy /runtime \
  && rm -f /runtime/node_modules/.modules.yaml

# pnpm deploy copies package-store files, so carry the explicitly built addon
# into the deployed dependency and verify that the production tree loads it.
RUN node --input-type=commonjs <<'NODE'
const {createRequire} = require('node:module');
const {dirname, join} = require('node:path');
const {mkdirSync, copyFileSync} = require('node:fs');
const runtime = createRequire('/runtime/package.json');
const foundation = createRequire(runtime.resolve('@coffee-platform/runtime'));
const kafka = createRequire(foundation.resolve('@coffee-platform/kafka-runtime'));
const destination = join(dirname(kafka.resolve('@confluentinc/kafka-javascript/package.json')), 'build/Release');
mkdirSync(destination, {recursive: true});
copyFileSync('node_modules/@confluentinc/kafka-javascript/build/Release/confluent-kafka-javascript.node', join(destination, 'confluent-kafka-javascript.node'));
if (typeof kafka('@confluentinc/kafka-javascript').RdKafka.Producer !== 'function') throw new Error('Deployed Kafka native addon is missing');
NODE

# Build the exact pinned Kafka source for G12 and update only the two
# pre-existing Alpine packages approved by the supply-chain gate.
FROM ${KAFKA_IMAGE} AS kafka
ARG LIBEXPAT_VERSION
USER root
RUN set -eu; \
    apk info -v | sort > /tmp/apk.before; \
    grep -Fxq 'brotli-libs-1.2.0-r1' /tmp/apk.before; \
    grep -Fxq 'libexpat-2.8.5-r0' /tmp/apk.before; \
    apk upgrade --no-cache brotli-libs libexpat; \
    apk info -v | sort > /tmp/apk.after; \
    grep -Fxq 'brotli-libs-1.2.1-r0' /tmp/apk.after; \
    grep -Fxq "libexpat-${LIBEXPAT_VERSION}" /tmp/apk.after; \
    sed \
      -e 's/^brotli-libs-1\.2\.0-r1$/brotli-libs-1.2.1-r0/' \
      -e "s/^libexpat-2\.8\.5-r0$/libexpat-${LIBEXPAT_VERSION}/" \
      /tmp/apk.before > /tmp/apk.expected; \
    diff -u /tmp/apk.expected /tmp/apk.after; \
    rm -f /tmp/apk.before /tmp/apk.after /tmp/apk.expected
USER appuser

FROM ${NODE_IMAGE} AS storage-helper
RUN --network=host apk add --no-cache --upgrade e2fsprogs util-linux libcrypto3 libssl3 \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && command -v mkfs.ext4 && command -v losetup && command -v blkid && command -v truncate

# G12 supplies the verified, signed vendor plugin context and the pinned base.
FROM ${GRAFANA_IMAGE} AS grafana
COPY --from=grafana-plugins --chown=472:472 /loki /opt/grafana/plugins/loki
COPY --from=grafana-plugins --chown=472:472 /tempo /opt/grafana/plugins/tempo
COPY --from=grafana-plugins --chown=472:472 /prometheus /opt/grafana/plugins/prometheus
ENV GF_PATHS_PLUGINS=/opt/grafana/plugins

# Package the pinned Keycloak distribution with the pinned Temurin runtime.
FROM ${KEYCLOAK_DISTRIBUTION_IMAGE} AS keycloak-distribution
FROM ${KEYCLOAK_RUNTIME_IMAGE} AS keycloak
ARG LIBEXPAT_VERSION
RUN set -eu; \
    apk info -v | sort > /tmp/apk.before; \
    grep -Fxq 'libexpat-2.9.0-r0' /tmp/apk.before; \
    apk upgrade --no-cache libexpat; \
    apk info -v | sort > /tmp/apk.after; \
    grep -Fxq "libexpat-${LIBEXPAT_VERSION}" /tmp/apk.after; \
    sed "s/^libexpat-2\.9\.0-r0$/libexpat-${LIBEXPAT_VERSION}/" \
      /tmp/apk.before > /tmp/apk.expected; \
    diff -u /tmp/apk.expected /tmp/apk.after; \
    rm -f /tmp/apk.before /tmp/apk.after /tmp/apk.expected
RUN addgroup -g 1000 keycloak && adduser -D -u 1000 -G keycloak keycloak
COPY --from=keycloak-distribution --chown=1000:1000 /opt/keycloak /opt/keycloak
WORKDIR /opt/keycloak
USER 1000:1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
ENV LD_LIBRARY_PATH=/usr/local/lib
WORKDIR /app

RUN --network=host apk add --no-cache --upgrade ca-certificates libcrypto3 libssl3 zlib zstd-libs lz4-libs libsasl libcurl \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=librdkafka-build /usr/local/lib/librdkafka.so* /usr/local/lib/
COPY --from=librdkafka-build /usr/local/lib/librdkafka++.so* /usr/local/lib/

ARG RUNTIME=edge-gateway
ENV RUNTIME_NAME=${RUNTIME}

# deploy --prod copies only the selected runtime and its production
# dependencies.  The final stage therefore contains neither TypeScript,
# oxlint, Dependency Cruiser nor code-generation tooling.
COPY --from=build /runtime ./
COPY config ./config
COPY platform/launch-v1-connectivity-policy.json ./platform/launch-v1-connectivity-policy.json
COPY scripts/permission-audit.mjs scripts/permission-enforce.mjs ./scripts/

USER node
ENTRYPOINT ["node", "scripts/permission-enforce.mjs"]
CMD ["--entry", "dist/main.js"]
