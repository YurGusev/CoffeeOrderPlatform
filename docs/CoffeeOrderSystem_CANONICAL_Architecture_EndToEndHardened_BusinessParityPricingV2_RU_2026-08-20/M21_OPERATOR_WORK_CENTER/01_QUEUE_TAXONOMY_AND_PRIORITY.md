# Queue taxonomy and priority

Queue item key = `(QueueKind, EntityRef, ReasonCode, SourceVersion)`.

Priority deterministic:

1. safety/financial correctness;
2. external UnknownOutcome/blocked mutation;
3. overdue customer/payment fulfillment;
4. stale pricing/availability preventing order progress;
5. manual matching/allocation;
6. informational recent changes.

Sort tie-breakers: priority desc, dueAt asc, occurredAt asc, stable EntityRef.

Queue state (`Open/Acknowledged/Snoozed/Resolved`) — Work Center projection metadata only. Resolving business problem требует owner command and подтверждённого downstream fact.
