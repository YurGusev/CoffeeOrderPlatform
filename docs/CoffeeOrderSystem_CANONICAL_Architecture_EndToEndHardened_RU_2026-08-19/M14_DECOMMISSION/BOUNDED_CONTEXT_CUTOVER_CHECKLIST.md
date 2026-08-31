# Checklist: bounded-context C# → TypeScript cutover

- [ ] C# characterization tests зафиксированы.
- [ ] TS parity tests зелёные.
- [ ] DB2/DB3 integration зелёный.
- [ ] Production DB4 read-shadow доказан.
- [ ] API contract compatible.
- [ ] Kafka event contract compatible.
- [ ] Outbox/Inbox/idempotency tested.
- [ ] Expand migration applied.
- [ ] Previous runtime может читать expanded schema.
- [ ] Target image/digest pinned.
- [ ] Nginx canary route готов.
- [ ] Target-specific dashboard/SLO готов.
- [ ] Единственный writer rule обеспечен.
- [ ] Rollback window определён.
- [ ] Cutover выполнен.
- [ ] Soak успешен.
- [ ] Contract cleanup выполняется только после закрытия rollback window.
