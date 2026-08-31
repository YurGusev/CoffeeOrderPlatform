# Checklist: React copy/handover

- [ ] Зафиксирован source commit текущего React.
- [ ] Зафиксирован `pnpm-lock.yaml` hash.
- [ ] Зафиксирован current Docker image/digest или воспроизводимый build.
- [ ] Скопированы source/config/tests/scripts без `node_modules`/build artifacts.
- [ ] Target `platform/apps/web` проходит source quality suite.
- [ ] API generation больше не зависит от `.NET obj/` path.
- [ ] Target web image использует build-stage Node и runtime static Nginx.
- [ ] CSP build/check parity доказан.
- [ ] `/app/*` можно route на old/new web independently.
- [ ] API остаётся same-origin через `coffee-edge`.
- [ ] E2E против C# API зелёный.
- [ ] Rollback old web image протестирован.
- [ ] После cutover old React source frozen.
- [ ] После soak old source удалён.
