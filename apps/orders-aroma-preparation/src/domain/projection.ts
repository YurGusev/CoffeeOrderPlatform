import type {DesiredBlocker, DesiredPlan} from "./desired.js";

export type CurrentDesired = Readonly<{desired_revision: string; desired_hash: string}>;
export type CurrentObserved = Readonly<{observed_revision: string; cart_fingerprint: string; captured_at: string; fresh: boolean}>;
export type Attempt = Readonly<{
  attempt_ref: string; desired_revision: string; desired_hash: string; fence_epoch: string; state: string;
  owner_instance_id: string; observed_start_revision: string | null; observed_end_revision: string | null;
  failure_code: string | null; blocker_codes: readonly string[];
}>;
export type ScopeFacts = Readonly<{
  desired?: CurrentDesired; observed?: CurrentObserved; attempt?: Attempt;
  fence_epoch: string | null; owner_instance_id: string | null; lease_active: boolean;
  unresolved: boolean; unknown: boolean; exactLines: boolean;
}>;
export type CardMaterial = Readonly<{
  order_ref: string; cart_scope_ref: "aroma-primary"; desired_revision: string; desired_hash: string | null;
  observed_revision: string; observed_cart_fingerprint: string | null;
  verified_desired_revision: string | null; verified_desired_hash: string | null;
  verified_observed_revision: string | null; verified_cart_fingerprint: string | null;
  attempt_ref: string | null; verified_attempt_ref: string | null; fence_epoch: string | null;
  state: "PendingObservation" | "UnknownOutcome" | "Blocked" | "Converging" | "InSync" | "OutOfSync";
  blocker_codes: readonly string[]; last_observed_at: string | null; source_message_id: string;
}>;

export function projectAromaCard(orderRef: string, plan: DesiredPlan, facts: ScopeFacts, sourceMessageId: string): CardMaterial {
  const {desired, observed, attempt} = facts;
  const perOrder: readonly DesiredBlocker[] = plan.blockers.filter(blocker => blocker.orderRef === orderRef);
  const currentContribution = plan.orders.some(order => order.orderRef === orderRef);
  const fenced = attempt !== undefined && attempt.fence_epoch === facts.fence_epoch && attempt.owner_instance_id === facts.owner_instance_id;
  const currentAttempt = fenced && attempt?.desired_revision === desired?.desired_revision && attempt?.desired_hash === desired?.desired_hash;
  const verifiedRevision = attempt?.state === "NoOpInSync" ? attempt.observed_start_revision : attempt?.observed_end_revision;
  const verified = currentAttempt && desired !== undefined && observed !== undefined && observed.fresh && currentContribution && facts.exactLines &&
    (attempt?.state === "NoOpInSync" || attempt?.state === "VerifiedInSync") && verifiedRevision === observed.observed_revision && !facts.unresolved;
  let state: CardMaterial["state"];
  let blockers = [...new Set(perOrder.map(blocker => blocker.code))].sort();
  if (!observed) state = "PendingObservation";
  else if (facts.unknown) {state = "UnknownOutcome"; blockers = [...new Set([...blockers, "AROMA_UNKNOWN_OUTCOME"])].sort();}
  else if (blockers.length > 0) state = "Blocked";
  else if (facts.lease_active) state = "Converging";
  else if (verified) state = "InSync";
  else if (currentAttempt && attempt !== undefined && ["Blocked", "Failed"].includes(attempt.state)) {
    state = "Blocked";
    blockers = [...new Set([...attempt.blocker_codes, ...(attempt.failure_code === null ? [] : [attempt.failure_code])])].sort();
  } else state = "OutOfSync";
  // An unresolved Reserved/Dispatched/Acknowledged is a barrier, even if its
  // terminal Attempt is a success. A recovered old UnknownOutcome is NOT proof.
  const inSync = state === "InSync";
  return {
    order_ref: orderRef, cart_scope_ref: "aroma-primary", desired_revision: desired?.desired_revision ?? "0", desired_hash: desired?.desired_hash ?? null,
    observed_revision: observed?.observed_revision ?? "0", observed_cart_fingerprint: observed?.cart_fingerprint ?? null,
    verified_desired_revision: inSync ? desired?.desired_revision ?? null : null, verified_desired_hash: inSync ? desired?.desired_hash ?? null : null,
    verified_observed_revision: inSync ? observed?.observed_revision ?? null : null, verified_cart_fingerprint: inSync ? observed?.cart_fingerprint ?? null : null,
    attempt_ref: attempt?.attempt_ref ?? null, verified_attempt_ref: inSync ? attempt?.attempt_ref ?? null : null,
    fence_epoch: attempt?.fence_epoch ?? null, state, blocker_codes: blockers,
    last_observed_at: observed?.captured_at ?? null, source_message_id: sourceMessageId,
  };
}
