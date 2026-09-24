FROM node:26.8.1-bookworm-slim@sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae
WORKDIR /fixture
COPY backend.mjs ./backend.mjs
USER 10001:10001
CMD ["node", "backend.mjs"]
