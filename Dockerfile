# syntax=docker/dockerfile:1.9

# The digest is deliberately repeated for the build and runtime stages.  This
# keeps the image identity immutable and makes a builder/runtime drift fail in
# review instead of silently selecting another Node release.
ARG NODE_IMAGE=node:26.8.1-bookworm-slim@sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae

FROM ${NODE_IMAGE} AS librdkafka-build

ARG LIBRDKAFKA_VERSION=2.15.0
ARG LIBRDKAFKA_SOURCE_SHA256=259015220cdca708afe838b5aa79ebf1a5fb710fb4179cf918d390aed85d5dbc
ENV JOBS=4
ENV MAKEFLAGS=-j4

WORKDIR /source

RUN --network=host apt-get -o Acquire::Retries=3 -o Acquire::ForceIPv4=true update \
  && apt-get install --yes --no-install-recommends ca-certificates curl gcc g++ make pkg-config libssl-dev zlib1g-dev libzstd-dev liblz4-dev libsasl2-dev libcurl4-openssl-dev \
  && curl --fail --location --retry 3 --output librdkafka.tar.gz "https://github.com/confluentinc/librdkafka/archive/refs/tags/v${LIBRDKAFKA_VERSION}.tar.gz" \
  && echo "${LIBRDKAFKA_SOURCE_SHA256}  librdkafka.tar.gz" | sha256sum --check --strict \
  && tar --extract --gzip --file librdkafka.tar.gz --strip-components=1 \
  && ./configure --prefix=/usr/local \
  && make -j4 \
  && make install \
  && test "$(PKG_CONFIG_PATH=/usr/local/lib/pkgconfig pkg-config --modversion rdkafka)" = "${LIBRDKAFKA_VERSION}" \
  && test -f /usr/local/lib/librdkafka.so \
  && test -f /usr/local/lib/librdkafka++.so

COPY patches/librdkafka-resume-wakeup.patch config/toolchain-versions.json /source/
RUN --network=host apt-get -o Acquire::Retries=3 -o Acquire::ForceIPv4=true update \
  && apt-get install --yes --no-install-recommends patch \
  && node -e "const fs=require('node:fs'),crypto=require('node:crypto');if(crypto.createHash('sha256').update(fs.readFileSync('librdkafka-resume-wakeup.patch')).digest('hex')!==require('./toolchain-versions.json').librdkafkaPatchSha256)throw Error('LIBRDKAFKA_PATCH_HASH_MISMATCH')" \
  && patch --batch --forward --fuzz=0 --strip=1 --input=librdkafka-resume-wakeup.patch \
  && make -j4 \
  && make install \
  && test "$(PKG_CONFIG_PATH=/usr/local/lib/pkgconfig pkg-config --modversion rdkafka)" = "${LIBRDKAFKA_VERSION}"

# Сохраняем пути workspace manifests без списка всех сервисов в Dockerfile.
# Изменение исходников повторяет только этот дешёвый шаг; его выход неизменен.
FROM ${NODE_IMAGE} AS workspace-manifests
WORKDIR /workspace
RUN --mount=type=bind,source=apps,target=apps \
    --mount=type=bind,source=packages,target=packages \
    mkdir /manifests \
    && cp --parents apps/*/package.json packages/*/package.json packages/contracts/*/package.json packages/generated/*/package.json /manifests/

FROM ${NODE_IMAGE} AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV LIBRARY_PATH=/usr/local/lib
ENV LD_LIBRARY_PATH=/usr/local/lib
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig

WORKDIR /workspace

RUN --network=host apt-get -o Acquire::Retries=3 -o Acquire::ForceIPv4=true update \
  && apt-get install --yes --no-install-recommends ca-certificates python3 make g++ pkg-config libssl3 zlib1g libzstd1 liblz4-1 libsasl2-2 libcurl4 \
  && rm -rf /var/lib/apt/lists/*

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
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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
  && ldd node_modules/@confluentinc/kafka-javascript/build/Release/confluent-kafka-javascript.node | grep --fixed-strings '/usr/local/lib/librdkafka.so.1'

COPY tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY types ./types
COPY config ./config
COPY scripts/check-node26-compatibility.mjs ./scripts/check-node26-compatibility.mjs

RUN node scripts/check-node26-compatibility.mjs \
  && pnpm exec tsc -b packages/platform-runtime/tsconfig.json --pretty false \
  && pnpm typecheck

# Runtime selection must not invalidate dependency installation, native addon
# compilation or the common typecheck when Compose materializes all 14 Node images.
ARG RUNTIME=edge-gateway
RUN test "${RUNTIME}" != "web" && pnpm --filter "@coffee-platform/${RUNTIME}" deploy --prod --legacy /runtime

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

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
ENV LD_LIBRARY_PATH=/usr/local/lib
WORKDIR /app

RUN --network=host apt-get -o Acquire::Retries=3 -o Acquire::ForceIPv4=true update \
  && apt-get install --yes --no-install-recommends ca-certificates libssl3 zlib1g libzstd1 liblz4-1 libsasl2-2 libcurl4 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=librdkafka-build /usr/local/lib/librdkafka.so* /usr/local/lib/
COPY --from=librdkafka-build /usr/local/lib/librdkafka++.so* /usr/local/lib/

ARG RUNTIME=edge-gateway
ENV RUNTIME_NAME=${RUNTIME}

# deploy --prod copies only the selected runtime and its production
# dependencies.  The final stage therefore contains neither TypeScript,
# oxlint, Dependency Cruiser nor code-generation tooling.
COPY --from=build /runtime ./
COPY --from=build /workspace/config ./config
COPY platform/launch-v1-connectivity-policy.json ./platform/launch-v1-connectivity-policy.json
COPY scripts/permission-audit.mjs scripts/permission-enforce.mjs ./scripts/

USER node
ENTRYPOINT ["node", "scripts/permission-enforce.mjs"]
CMD ["--entry", "dist/main.js"]
