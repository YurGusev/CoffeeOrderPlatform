# VK LongPoll → Callback cutover

Во время overlap LongPoll и Callback могут увидеть одно provider event. Оба входят через единый ingress dedupe store.

Cutover:

1. Callback shadow ingest, no downstream delivery.
2. Compare normalized events.
3. Enable callback downstream with shared dedupe.
4. Observe duplicates/loss.
5. Disable LongPoll producer.
6. Rollback window.
7. Delete legacy LongPoll only after zero-use evidence.
