FROM node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS web-build
WORKDIR /workspace
COPY . .
RUN --network=host npm install --global corepack@0.35.0 && corepack enable && pnpm install --frozen-lockfile && pnpm web:build \
 && node tools/nginx/generate-config.mjs --config config/platform.yaml --output apps/edge-nginx/generated/nginx.conf

FROM nginx:1.31.6-trixie@sha256:908dc23e643a1447dbfb2e189ed268bfde6a51a5bf9a34d3dd3440a24f58ccf7 AS edge-nginx
RUN rm -f /etc/nginx/conf.d/default.conf /usr/bin/apt /usr/bin/apt-* /usr/bin/dpkg /usr/bin/dpkg-* /usr/sbin/apt-* /usr/sbin/dpkg-* \
 && rm -rf /usr/lib/apt /var/lib/apt /var/lib/dpkg \
 && rm -f /etc/nginx/nginx.conf \
 && mkdir -p /etc/nginx/snippets /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp \
 && chown -R 101:101 /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp \
 && chmod -R a=rX /etc/nginx /usr/share/nginx/html
COPY --from=web-build --chown=0:0 /workspace/apps/web/dist/browser/ /usr/share/nginx/html/
COPY --from=web-build --chown=0:0 /workspace/apps/edge-nginx/generated/nginx.conf /etc/nginx/nginx.conf
COPY apps/edge-nginx/snippets/upstream-tls.conf /etc/nginx/snippets/upstream-tls.conf
COPY apps/edge-nginx/snippets/business-headers.conf /etc/nginx/snippets/business-headers.conf
USER 101:101
EXPOSE 8443
HEALTHCHECK --interval=5s --timeout=1s --start-period=5s --retries=3 CMD ["/usr/sbin/nginx", "-t", "-q"]
STOPSIGNAL SIGQUIT
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
