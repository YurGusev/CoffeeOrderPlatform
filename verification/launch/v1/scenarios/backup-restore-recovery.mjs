import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { load as parseYaml } from "js-yaml";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const owners = ["customer", "catalog", "pricing", "orders", "integration"];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const RECOVERY_ADMIN_QUERY_TIMEOUT_MS = 25_000;
const RECOVERY_ADMIN_LOCK_TIMEOUT_MS = 5_000;

function recoveryFixtureRef(prefix, seed) {
  const bytes = createHash("sha256").update(seed).digest();
  let value = BigInt(`0x${bytes.subarray(0, 16).toString("hex")}`);
  let suffix = "";
  for (let index = 0; index < 26; index++) {
    suffix = alphabet[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return `${prefix}_${suffix}`;
}

function requireProof(value, code) {
  if (!value) throw Object.assign(new Error(code), { code });
}

function waitFor(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("BACKUP_RECOVERY_ABORTED"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function verifyRecoveryUnknownOutcomeTrace(trace, oldOperationRef) {
  requireProof(
    Array.isArray(trace) && trace[0]?.kind === "GET",
    "BACKUP_UNKNOWN_OUTCOME_RECOVERY_NOT_GET_FIRST",
  );
  requireProof(
    !trace.some(
      (entry) =>
        entry?.kind === "MUTATION" && entry.operationRef === oldOperationRef,
    ),
    "BACKUP_UNKNOWN_OUTCOME_OLD_OPERATION_REPLAYED",
  );
  return { firstAction: trace[0].kind, oldOperationRefReplayed: false };
}

function createDatabaseOptions({
  owner,
  database,
  host,
  port,
  user,
  password,
  pool,
  shutdownGraceMs,
}) {
  return {
    owner,
    database,
    allowedDatabase: database,
    host,
    port,
    user,
    password: password.password,
    ssl: false,
    pool,
    shutdownGraceMs,
  };
}

async function openDatabase(factory, options, signal) {
  const database = factory(options);
  await database.resource.start(signal);
  return database;
}

export async function openRecoveryAdminClient({
  host,
  port,
  database,
  password,
  signal,
  ClientClass,
}) {
  signal?.throwIfAborted();
  const Client = ClientClass ?? (await import("pg")).Client;
  const client = new Client({
    host,
    port,
    database,
    user: "postgres",
    password,
    ssl: false,
    connectionTimeoutMillis: 3_000,
    query_timeout: RECOVERY_ADMIN_QUERY_TIMEOUT_MS,
    statement_timeout: RECOVERY_ADMIN_QUERY_TIMEOUT_MS,
    lock_timeout: RECOVERY_ADMIN_LOCK_TIMEOUT_MS,
  });
  const abortClient = () => {
    Promise.resolve(client.end()).catch(() => {});
  };
  signal?.addEventListener("abort", abortClient, { once: true });
  client.once("end", () => signal?.removeEventListener("abort", abortClient));
  try {
    await client.connect();
    signal?.throwIfAborted();
  } catch (error) {
    signal?.removeEventListener("abort", abortClient);
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}

async function openAdminClient(host, port, database, password, signal) {
  return openRecoveryAdminClient({ host, port, database, password, signal });
}

export function queryRecoveryInboxByMessageIds(client, messageIds) {
  requireProof(
    Array.isArray(messageIds) &&
      messageIds.length > 0 &&
      messageIds.every((id) => typeof id === "string" && id.length > 0),
    "BACKUP_INBOX_MESSAGE_IDS_INVALID",
  );
  return client.query(
    `SELECT message_id, state, envelope FROM orders.inbox_messages
     WHERE consumer_name='g17-backup-restore-v1' AND message_id = ANY($1::text[])`,
    [messageIds],
  );
}

async function verifyFixtureSourceTargets({
  target,
  runId,
  password,
  config,
  sourceDatabases,
  expectedVersion,
  roleMap,
  signal,
}) {
  requireProof(
    config.environment !== "production" &&
      config.postgres?.host === target.host &&
      config.postgres?.port === target.port &&
      /^[0-9]+$/u.test(target.systemIdentifier ?? "") &&
      owners.every(
        (owner) =>
          sourceDatabases[owner] ===
          `coffee_verify_${runId.toLowerCase().replace("-", "_")}_${owner}`,
      ),
    "BACKUP_FIXTURE_TARGET_INVALID",
  );
  for (const owner of owners) {
    const role = roleMap.databases.find(
      (entry) => entry.name === `coffee_platform_${owner}`,
    )?.migratorRole;
    requireProof(
      role === `coffee_${owner}_migrator`,
      "BACKUP_OWNER_MAP_INVALID",
    );
    const client = await openAdminClient(
      target.host,
      target.port,
      sourceDatabases[owner],
      password,
      signal,
    );
    try {
      const { rows } = await client.query(
        `SELECT current_database() AS database,current_user AS username,
         split_part(current_setting('server_version'),' ',1) AS version,
         (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
         (SELECT role.rolname FROM pg_database AS catalog JOIN pg_roles AS role ON role.oid=catalog.datdba
          WHERE catalog.datname=current_database()) AS database_owner`,
      );
      const { database, username, version, system_identifier, database_owner } =
        rows[0] ?? {};
      requireProof(
        database === sourceDatabases[owner] &&
          username === "postgres" &&
          version === expectedVersion &&
          system_identifier === target.systemIdentifier &&
          database_owner === role,
        "BACKUP_FIXTURE_SERVER_IDENTITY_MISMATCH",
      );
    } finally {
      await client.end();
    }
  }
}

export function optionsFor(owner, runtime, config, target, credential) {
  const service = config.services[runtime];
  if (
    !service?.dbPool ||
    !service.database ||
    !credential ||
    typeof credential.username !== "string" ||
    !/^coffee_[a-z_]+_(?:rw|ro)$/u.test(credential.username) ||
    typeof credential.password !== "string" ||
    !credential.password
  )
    throw new Error("BACKUP_RECOVERY_CONFIG_INVALID");
  return createDatabaseOptions({
    owner: runtime,
    database: owner,
    host: target.host,
    port: target.port,
    user: credential.username,
    password: credential,
    pool: service.dbPool,
    shutdownGraceMs: config.platform?.shutdownGraceMs,
  });
}

async function seedConfirmedContribution({
  admin,
  runId,
  suffix,
  productRef,
  variantRef,
  offerRef,
  quantityMilli,
}) {
  const { canonicalRequestHash } =
    await import("../../../../packages/platform-idempotency/dist/index.js");
  const orderRef = recoveryFixtureRef(
    "ord",
    suffix === "primary" ? `${runId}:orders` : `${runId}:orders:${suffix}`,
  );
  const customerRef = recoveryFixtureRef("cus", `${runId}:${suffix}`);
  const itemRef = recoveryFixtureRef("itm", `${runId}:items:${suffix}`);
  const quoteRef = recoveryFixtureRef("prq", `${runId}:quotes:${suffix}`);
  const policyVersionRef = recoveryFixtureRef(
    "pvr",
    `${runId}:policy:${suffix}`,
  );
  const itemHash = canonicalRequestHash({ itemRef });
  await admin.query(
    `INSERT INTO orders.orders(order_ref,status,version,projection_version,customer_ref,customer_version,
      customer_display_name,customer_state,customer_state_proof_hash,currency,created_by_actor_ref,last_modified_by_actor_ref)
     VALUES($1,'Draft',1,1,$2,1,'backup_restore isolated fixture','Active',$3,'RUB','g17-backup-restore','g17-backup-restore')`,
    [orderRef, customerRef, sha(`${runId}:${suffix}:customer`)],
  );
  await admin.query(
    `INSERT INTO orders.order_items(order_ref,item_ref,line_position,product_ref,variant_ref,product_display_name,unit,
      quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,
      catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency,source_grind_key_hash,grind_display_name)
     VALUES($1,$2,1,$3,$4,'backup_restore isolated fixture','piece',$5::bigint,$6,1,$7,$7,clock_timestamp()+interval '1 hour',$8,
      1,1,$9,0,0,'RUB',NULL,NULL)`,
    [
      orderRef,
      itemRef,
      productRef,
      variantRef,
      quantityMilli,
      quoteRef,
      itemHash,
      policyVersionRef,
      offerRef,
    ],
  );
  await admin.query(
    `UPDATE orders.orders SET status='Confirmed',version=2,projection_version=2,currency='RUB',confirmed_at=clock_timestamp()
     WHERE order_ref=$1`,
    [orderRef],
  );
  await admin.query(
    `INSERT INTO orders.order_desired_contributions(order_ref,contribution_revision,order_version)
     VALUES($1,1,2)`,
    [orderRef],
  );
  await admin.query(
    `INSERT INTO orders.order_desired_contribution_lines(order_ref,contribution_revision,offer_ref,quantity_milli,
      contribution_hash,item_refs,source_grind_key_hash)
     VALUES($1,1,$2,$3::bigint,$4,ARRAY[$5]::varchar(30)[],NULL)`,
    [orderRef, offerRef, quantityMilli, itemHash, itemRef],
  );
  return { orderRef, customerRef, itemRef, itemHash };
}

async function seedDraftOutboxAggregate({ admin, runId, customerRef }) {
  const orderRef = recoveryFixtureRef("ord", `${runId}:outbox-aggregate`);
  await admin.query(
    `INSERT INTO orders.orders(order_ref,status,version,projection_version,customer_ref,customer_version,
      customer_display_name,customer_state,customer_state_proof_hash,currency,created_by_actor_ref,last_modified_by_actor_ref)
     VALUES($1,'Draft',1,1,$2,1,'backup_restore isolated fixture','Active',$3,'RUB','g17-backup-restore','g17-backup-restore')`,
    [orderRef, customerRef, sha(`${runId}:primary:customer`)],
  );
  return orderRef;
}

async function expectedRecoveryDesiredPlan(
  runId,
  { offerRef, productRef, variantRef },
) {
  const { canonicalRequestHash } =
    await import("../../../../packages/platform-idempotency/dist/index.js");
  const { buildDesired } =
    await import("../../../../apps/orders-aroma-preparation/dist/domain/desired.js");
  const contributions = ["primary", "secondary"].map((suffix) => {
    const orderRef = recoveryFixtureRef(
      "ord",
      suffix === "primary" ? `${runId}:orders` : `${runId}:orders:${suffix}`,
    );
    const itemRef = recoveryFixtureRef("itm", `${runId}:items:${suffix}`);
    const contributionHash = canonicalRequestHash({ itemRef });
    return {
      order: {
        order_ref: orderRef,
        contribution_revision: "1",
        order_version: "2",
      },
      line: {
        order_ref: orderRef,
        contribution_revision: "1",
        offer_ref: offerRef,
        source_grind_key_hash: null,
        quantity_milli: "1000",
        contribution_hash: contributionHash,
        item_refs: [itemRef],
        items: [
          {
            itemRef,
            found: true,
            productRef,
            variantRef,
            offerRef,
            grind: null,
            quantity: "1000",
            mappingOffer: offerRef,
            mappingRevision: "1",
            mappingState: "Active",
            availability: "Available",
          },
        ],
      },
    };
  });
  return buildDesired(
    contributions.map(({ order }) => order),
    contributions.map(({ line }) => line),
    100,
    1000,
  );
}

function makeEnvelope({
  messageId,
  messageType,
  aggregateType,
  aggregateRef,
  ownerVersion,
  payload,
  occurredAt,
  correlationId,
  traceparent,
}) {
  return {
    envelopeVersion: "1",
    messageId,
    messageType,
    occurredAt,
    producer: "g17-backup-restore",
    correlationId,
    causationId: null,
    traceparent,
    aggregate: {
      type: aggregateType,
      ref: aggregateRef,
      version: ownerVersion,
    },
    payload,
  };
}

async function orderFixture({ database, runId, signal }) {
  const { createDatabase } =
    await import("../../../../packages/platform-database/dist/index.js");
  const { withTransaction } =
    await import("../../../../packages/platform-database/dist/index.js");
  const { createSqlInboxStore, consumeOnce } =
    await import("../../../../packages/platform-inbox/dist/index.js");
  const { createSqlOutboxStore, relayOutboxBatch } =
    await import("../../../../packages/platform-outbox/dist/index.js");
  const { createAromaConvergenceStore } =
    await import("../../../../apps/aroma-convergence/dist/infrastructure/convergence-store.js");
  const { createAromaPreparationStore } =
    await import("../../../../apps/orders-aroma-preparation/dist/infrastructure/preparation-store.js");
  const {
    database: dbName,
    host,
    port,
    password,
    runtimeCredentials,
    config,
  } = database;
  const orders = await openDatabase(
    createDatabase,
    optionsFor(
      dbName,
      "aroma-convergence",
      config,
      { host, port },
      runtimeCredentials["aroma-convergence"],
    ),
    signal,
  );
  const preparationDb = await openDatabase(
    createDatabase,
    optionsFor(
      dbName,
      "orders-aroma-preparation",
      config,
      { host, port },
      runtimeCredentials["orders-aroma-preparation"],
    ),
    signal,
  );
  const admin = await openAdminClient(host, port, dbName, password, signal);
  try {
    const baseline = await admin.query(`SELECT
      (SELECT count(*)::int FROM orders.cart_desired_revisions) AS desired,
      (SELECT count(*)::int FROM orders.convergence_attempts) AS attempts,
      (SELECT count(*)::int FROM orders.mutation_reservations) AS reservations,
      (SELECT count(*)::int FROM orders.inbox_messages) AS inbox,
      (SELECT count(*)::int FROM orders.outbox_messages) AS outbox`);
    const prior = baseline.rows[0];
    requireProof(
      Object.values(prior).every((value) => value === 0),
      "BACKUP_SOURCE_FIXTURE_TARGET_NOT_EMPTY",
    );

    const offerRef = recoveryFixtureRef("off", `${runId}:offer`);
    const productRef = recoveryFixtureRef("prd", `${runId}:product`);
    const variantRef = recoveryFixtureRef("var", `${runId}:variant`);
    const now = new Date().toISOString();
    await admin.query(
      `INSERT INTO orders.catalog_mapping_projection(product_ref,variant_ref,offer_ref,mapping_revision,
      catalog_snapshot_revision,mapping_state,availability,effective_at,source_message_id,payload_hash)
      VALUES($1,$2,$3,1,1,'Active','Available',$4::timestamptz,$5,$6)`,
      [
        productRef,
        variantRef,
        offerRef,
        now,
        `g17-${runId}`,
        sha(`${runId}:mapping`),
      ],
    );
    const platformConfig = parseYaml(
      await readFile(
        new URL("../../../../config/platform.yaml", import.meta.url),
        "utf8",
      ),
      { json: true },
    );
    const preparationSettings = {
      ...platformConfig.services["orders-aroma-preparation"].aromaPreparation,
      maxSnapshotAgeMs:
        platformConfig.services["aroma-convergence"].aromaConvergence
          .maxSnapshotAgeMs,
    };
    const preparation = createAromaPreparationStore(
      preparationDb,
      preparationSettings,
    );
    const primary = await seedConfirmedContribution({
      admin,
      runId,
      suffix: "primary",
      productRef,
      variantRef,
      offerRef,
      quantityMilli: "1000",
    });
    const initialPreparation = await preparation.runOnce(signal);
    requireProof(
      initialPreparation === "prepared",
      "BACKUP_SOURCE_INITIAL_PREPARATION_FAILED",
    );
    const initialDesired = await admin.query(
      "SELECT desired_revision::text AS revision FROM orders.cart_desired_revisions WHERE state='Current'",
    );
    requireProof(
      initialDesired.rows[0]?.revision === "1",
      "BACKUP_SOURCE_INITIAL_DESIRED_FAILED",
    );

    const settings =
      platformConfig.services["aroma-convergence"].aromaConvergence;
    const convergence = createAromaConvergenceStore(orders, {
      ownerInstanceId: randomUUID(),
      mutationsEnabled: true,
      ...settings,
    });
    const beforeTrace = [];
    let physicalQuantity = "1";
    const fakeGateway = {
      catalogInput: async () => ({
        productRef,
        variantRef,
        offerRef,
        snapshotRevision: "1",
        supplierUnitMinor: "1",
        currency: "RUB",
        unit: "piece",
        availability: "Available",
        mappingRevision: "1",
        displayName: "backup_restore fixture",
      }),
      read: async () => {
        beforeTrace.push("GET");
        const lines = [{ offerRef, quantity: physicalQuantity }];
        return {
          cartScopeRef: "aroma-primary",
          capturedAt: new Date().toISOString(),
          providerSnapshotRef: `aroma-gateway:cart-body-sha256:${sha(JSON.stringify(lines))}`,
          cartFingerprint: sha(JSON.stringify(lines)),
          lines,
        };
      },
      setQuantity: async (_offer, request) => {
        beforeTrace.push("MUTATION");
        physicalQuantity = request.quantity;
        throw new Error("backup_restore controlled lost response");
      },
      remove: async () => {
        beforeTrace.push("MUTATION");
        throw new Error("unexpected backup_restore fixture removal");
      },
    };
    await convergence.recover(signal);
    await convergence.runOnce(fakeGateway, signal);
    const completed = await admin.query(
      "SELECT count(*)::int AS count FROM orders.convergence_attempts WHERE state='NoOpInSync'",
    );
    requireProof(
      completed.rows[0]?.count === 1,
      "BACKUP_SOURCE_COMPLETED_ATTEMPT_FIXTURE_FAILED",
    );
    await seedConfirmedContribution({
      admin,
      runId,
      suffix: "secondary",
      productRef,
      variantRef,
      offerRef,
      quantityMilli: "1000",
    });
    const nextPreparation = await preparation.runOnce(signal);
    requireProof(
      nextPreparation === "prepared",
      "BACKUP_SOURCE_NEXT_PREPARATION_FAILED",
    );
    const currentDesired = await admin.query(
      "SELECT desired_revision::text AS revision,desired_hash FROM orders.cart_desired_revisions WHERE state='Current'",
    );
    const expectedPlan = await expectedRecoveryDesiredPlan(runId, {
      offerRef,
      productRef,
      variantRef,
    });
    requireProof(
      currentDesired.rows[0]?.revision === "2" &&
        currentDesired.rows[0]?.desired_hash === expectedPlan.hash,
      "BACKUP_SOURCE_NEXT_DESIRED_FAILED",
    );
    physicalQuantity = "1";
    beforeTrace.length = 0;
    await convergence.runOnce(fakeGateway, signal);
    physicalQuantity = "2";
    const unknown =
      await admin.query(`SELECT a.state AS attempt_state,r.state AS reservation_state,r.operation_ref,
      r.offer_ref,r.desired_milli::text AS desired_milli
      FROM orders.convergence_attempts a JOIN orders.mutation_reservations r USING(attempt_ref)
      WHERE a.desired_revision=2 ORDER BY a.started_at DESC LIMIT 1`);
    requireProof(
      unknown.rows[0]?.attempt_state === "UnknownOutcome" &&
        unknown.rows[0]?.reservation_state === "UnknownOutcome" &&
        unknown.rows[0]?.offer_ref === offerRef &&
        unknown.rows[0]?.desired_milli === "2000" &&
        beforeTrace[0] === "GET" &&
        beforeTrace[1] === "MUTATION",
      "BACKUP_SOURCE_UNKNOWN_OUTCOME_FIXTURE_FAILED",
    );
    const interruptedAttempt = recoveryFixtureRef(
      "att",
      `${runId}:unfinished-attempt`,
    );
    await admin.query(
      `INSERT INTO orders.convergence_attempts(attempt_ref,cart_scope_ref,desired_revision,desired_hash,
      owner_instance_id,fence_epoch,state) VALUES($1,'aroma-primary',2,$2,$3::uuid,999,'Started')`,
      [interruptedAttempt, expectedPlan.hash, randomUUID()],
    );

    const inbox = createSqlInboxStore(orders, {
      schema: "orders",
      consumerName: "g17-backup-restore-v1",
    });
    const inboxId = recoveryFixtureRef("msg", `${runId}:inbox`);
    const inboxPayload = { fixture: "g17", runId };
    const inboxMessage = {
      messageId: inboxId,
      messageType: "BackupRestoreFixture.v1",
      receivedAt: now,
      payloadHash: sha(JSON.stringify(inboxPayload)),
      payload: inboxPayload,
    };
    const inboxHash = (
      await import("../../../../packages/platform-idempotency/dist/index.js")
    ).canonicalRequestHash(inboxPayload);
    inboxMessage.payloadHash = inboxHash;
    const processed = {
      messageId: recoveryFixtureRef("msg", `${runId}:inbox-completed`),
      messageType: "BackupRestoreFixture.v1",
      receivedAt: now,
      payloadHash: inboxHash,
      payload: { ...inboxPayload, completed: true },
    };
    processed.payloadHash = (
      await import("../../../../packages/platform-idempotency/dist/index.js")
    ).canonicalRequestHash(processed.payload);
    const processedEnvelope = makeEnvelope({
      messageId: processed.messageId,
      messageType: processed.messageType,
      aggregateType: "BackupRestoreFixture",
      aggregateRef: "g17-backup-restore",
      ownerVersion: "1",
      payload: processed.payload,
      occurredAt: now,
      correlationId: randomUUID(),
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    });
    processed.payload = processedEnvelope;
    processed.payloadHash = (
      await import("../../../../packages/platform-idempotency/dist/index.js")
    ).canonicalRequestHash(processedEnvelope);
    await withTransaction(orders, { mode: "background", signal }, (tx) =>
      consumeOnce(
        inbox,
        tx,
        processed,
        "g17-backup-restore-v1",
        Date.now(),
        30_000,
        async () => {},
        now,
      ),
    );
    const pendingEnvelope = makeEnvelope({
      messageId: inboxId,
      messageType: inboxMessage.messageType,
      aggregateType: "BackupRestoreFixture",
      aggregateRef: "g17-backup-restore",
      ownerVersion: "1",
      payload: inboxPayload,
      occurredAt: now,
      correlationId: randomUUID(),
      traceparent: "00-22222222222222222222222222222222-3333333333333333-01",
    });
    inboxMessage.payload = pendingEnvelope;
    inboxMessage.payloadHash = (
      await import("../../../../packages/platform-idempotency/dist/index.js")
    ).canonicalRequestHash(pendingEnvelope);
    await withTransaction(orders, { mode: "background", signal }, (tx) =>
      inbox.begin(
        tx,
        inboxMessage,
        "g17-interrupted-consumer",
        Date.now() - 60_000,
        1_000,
      ),
    );

    const topic = "coffee.orders.lifecycle.v1";
    const outbox = createSqlOutboxStore(orders, {
      schema: "orders",
      envelopeBytes: true,
      topics: [topic],
    });
    // Keep these lifecycle messages on their own valid Draft aggregate. The
    // production claim policy blocks later messages behind any unpublished
    // predecessor on the same aggregate, including other topics.
    const outboxOrderRef = await seedDraftOutboxAggregate({
      admin,
      runId,
      customerRef: primary.customerRef,
    });
    const previousSequence = await admin.query(
      "SELECT COALESCE(max(aggregate_sequence),0)::text AS sequence FROM orders.outbox_messages WHERE aggregate_ref=$1",
      [outboxOrderRef],
    );
    const outboxMessages = ["completed", "pending"].map((state, index) => {
      const messageId = recoveryFixtureRef("msg", `${runId}:outbox:${state}`);
      const messageType = `BackupRestore${state === "completed" ? "Completed" : "Pending"}.v1`;
      const aggregateSequence =
        BigInt(previousSequence.rows[0].sequence) + BigInt(index) + 1n;
      requireProof(
        aggregateSequence <= BigInt(Number.MAX_SAFE_INTEGER),
        "BACKUP_SOURCE_OUTBOX_SEQUENCE_INVALID",
      );
      const aggregateSequenceNumber = Number(aggregateSequence);
      const payload = { runId, fixture: state };
      const envelope = makeEnvelope({
        messageId,
        messageType,
        aggregateType: "Order",
        aggregateRef: outboxOrderRef,
        ownerVersion: aggregateSequence.toString(),
        payload,
        occurredAt: now,
        correlationId: randomUUID(),
        traceparent: "00-33333333333333333333333333333333-4444444444444444-01",
      });
      return {
        messageId,
        messageType,
        topic,
        aggregateRef: outboxOrderRef,
        aggregateSequence: aggregateSequenceNumber,
        ownerVersion: aggregateSequence.toString(),
        partitionKey: outboxOrderRef,
        schemaVersion: "1",
        envelope,
        payload,
        occurredAt: now,
        correlationId: envelope.correlationId,
        traceparent: envelope.traceparent,
      };
    });
    for (const message of outboxMessages)
      await withTransaction(orders, { mode: "background", signal }, (tx) =>
        outbox.enqueue(tx, message),
      );
    const sent = [];
    const relayOptions = {
      nowMs: Date.now(),
      leaseOwner: "g17-source-fixture",
      policy: {
        leaseMs: 30_000,
        sendTimeoutMs: 5_000,
        maxInFlight: 1,
        retry: { baseMs: 1_000, maxMs: 5_000, maxAttempts: 3 },
      },
      signal,
    };
    await relayOutboxBatch(
      outbox,
      orders,
      async (claim) => {
        sent.push(claim.message.messageId);
        return { kind: "ack" };
      },
      relayOptions,
    );
    requireProof(
      sent.length === 1 && sent[0] === outboxMessages[0].messageId,
      "BACKUP_SOURCE_OUTBOX_FIXTURE_FAILED",
    );

    return {
      orderRef: primary.orderRef,
      offerRef,
      productRef,
      variantRef,
      desiredHash: expectedPlan.hash,
      operationRef: unknown.rows[0].operation_ref,
      completedAttemptCount: completed.rows[0].count,
      interruptedAttempt,
      inbox: {
        completedMessageId: processed.messageId,
        completedEnvelope: processedEnvelope,
        pendingMessageId: inboxId,
        pendingEnvelope,
      },
      outbox: {
        aggregateRef: outboxOrderRef,
        completedMessageId: outboxMessages[0].messageId,
        pendingMessageId: outboxMessages[1].messageId,
      },
    };
  } finally {
    await Promise.allSettled([
      orders.resource.stop(AbortSignal.timeout(5_000)),
      preparationDb.resource.stop(AbortSignal.timeout(5_000)),
      admin.end(),
    ]);
  }
}

async function gatewayFixture({ database, runId, signal }) {
  const { createDatabase } =
    await import("../../../../packages/platform-database/dist/index.js");
  const { ProviderMutationJournalStore } =
    await import("../../../../apps/aroma-gateway/dist/infrastructure/database/provider-mutation-journal.js");
  const { GatewayMutationExecutor } =
    await import("../../../../apps/aroma-gateway/dist/domain/mutation-journal.js");
  const db = await openDatabase(
    createDatabase,
    optionsFor(
      database.database,
      "aroma-gateway",
      database.config,
      { host: database.host, port: database.port },
      database.runtimeCredentials["aroma-gateway"],
    ),
    signal,
  );
  const admin = await openAdminClient(
    database.host,
    database.port,
    database.database,
    database.password,
    signal,
  );
  try {
    const existing = await admin.query(
      "SELECT count(*)::int AS count FROM integration.provider_mutation_journal",
    );
    requireProof(
      existing.rows[0]?.count === 0,
      "BACKUP_SOURCE_JOURNAL_FIXTURE_TARGET_NOT_EMPTY",
    );
    const journal = new ProviderMutationJournalStore(db);
    const request = {
      operationRef: recoveryFixtureRef("op", `${runId}:gateway-operation`),
      cartScopeRef: "aroma-primary",
      operationKind: "SetLineQuantity",
      offerRef: recoveryFixtureRef("off", `${runId}:gateway-offer`),
      quantityMilli: "1000",
    };
    const delegation = {
      transportCaller: "api-internal",
      issuer: "api-internal",
      audience: "aroma-gateway",
      originalCaller: "aroma-convergence",
      operationId: "setAromaCartLineQuantity",
      callerIdentity: "api-internal",
      correlationId: randomUUID(),
      traceparent: "00-44444444444444444444444444444444-5555555555555555-01",
    };
    let dispatches = 0;
    const executor = new GatewayMutationExecutor(journal, async () => {
      dispatches++;
      throw new Error("backup_restore controlled lost response");
    });
    const result = await executor.execute(request, delegation, signal);
    requireProof(
      result.state === "UnknownOutcome" && dispatches === 1,
      "BACKUP_SOURCE_JOURNAL_FIXTURE_FAILED",
    );
    return { request, delegation };
  } finally {
    await Promise.allSettled([
      db.resource.stop(AbortSignal.timeout(5_000)),
      admin.end(),
    ]);
  }
}

/** Explicit pre-snapshot operation; never call this from the backup/restore gate. */
export async function prepareRecoveryFixtures({
  target,
  password,
  runtimeCredentials,
  config,
  sourceDatabases,
  runId,
  candidateSha,
  signal,
}) {
  requireProof(
    /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(runId ?? "") &&
      /^[0-9a-f]{40}$/u.test(candidateSha ?? "") &&
      runId.endsWith(`-${candidateSha.slice(0, 7)}`) &&
      Object.keys(sourceDatabases ?? {})
        .sort()
        .join(",") === [...owners].sort().join(","),
    "BACKUP_FIXTURE_IDENTITY_INVALID",
  );
  const toolchain = JSON.parse(
    await readFile(
      new URL("../../../../config/toolchain-versions.json", import.meta.url),
      "utf8",
    ),
  );
  requireProof(
    toolchain?.postgresql === "17.11" &&
      target &&
      typeof target.host === "string" &&
      Number.isInteger(target.port) &&
      /^[0-9]+$/u.test(target.systemIdentifier ?? ""),
    "BACKUP_FIXTURE_TARGET_INVALID",
  );
  const roleMap = JSON.parse(
    await readFile(
      new URL("../../../../config/database-role-map.json", import.meta.url),
      "utf8",
    ),
  );
  await verifyFixtureSourceTargets({
    target,
    runId,
    password,
    config,
    sourceDatabases,
    expectedVersion: toolchain.postgresql,
    roleMap,
    signal,
  });
  const database = {
    host: target.host,
    port: target.port,
    password,
    runtimeCredentials,
    config,
  };
  const [orders, gateway] = await Promise.all([
    orderFixture({
      database: { ...database, database: sourceDatabases.orders },
      runId,
      signal,
    }),
    gatewayFixture({
      database: { ...database, database: sourceDatabases.integration },
      runId,
      signal,
    }),
  ]);
  return {
    orders,
    gateway: {
      operationRef: gateway.request.operationRef,
      request: gateway.request,
      delegation: gateway.delegation,
    },
  };
}

/** Read-only pre-dump check for fixtures created by the separate setup operation. */
export async function inspectRecoveryFixtures({
  target,
  password,
  runtimeCredentials,
  config,
  sourceDatabases,
  runId,
  signal,
}) {
  const { createDatabase } =
    await import("../../../../packages/platform-database/dist/index.js");
  const ordersName = sourceDatabases.orders;
  const orders = await openDatabase(
    createDatabase,
    optionsFor(
      ordersName,
      "aroma-convergence",
      config,
      target,
      runtimeCredentials["aroma-convergence"],
    ),
    signal,
  );
  const ordersAdmin = await openAdminClient(
    target.host,
    target.port,
    ordersName,
    password,
    signal,
  );
  let orderFacts;
  try {
    const orderRef = recoveryFixtureRef("ord", `${runId}:orders`);
    const offerRef = recoveryFixtureRef("off", `${runId}:offer`);
    const productRef = recoveryFixtureRef("prd", `${runId}:product`);
    const variantRef = recoveryFixtureRef("var", `${runId}:variant`);
    const desired = await ordersAdmin.query(
      `SELECT desired_revision, state, desired_hash FROM orders.cart_desired_revisions
       WHERE cart_scope_ref='aroma-primary' AND desired_revision IN (1,2) ORDER BY desired_revision`,
    );
    const expectedPlan = await expectedRecoveryDesiredPlan(runId, {
      offerRef,
      productRef,
      variantRef,
    });
    requireProof(
      desired.rows.length === 2 &&
        desired.rows[0].desired_revision === "1" &&
        desired.rows[0].state === "Superseded" &&
        desired.rows[1].desired_revision === "2" &&
        desired.rows[1].state === "Current" &&
        desired.rows[1].desired_hash === expectedPlan.hash,
      "BACKUP_RECOVERY_FIXTURE_DESIRED_MISSING",
    );
    const exactOrder = await ordersAdmin.query(
      "SELECT count(*)::int AS count FROM orders.orders WHERE order_ref = ANY($1::varchar(30)[])",
      [[orderRef, recoveryFixtureRef("ord", `${runId}:orders:secondary`)]],
    );
    const exactMapping = await ordersAdmin.query(
      `SELECT count(*)::int AS count FROM orders.catalog_mapping_projection
       WHERE product_ref=$1 AND variant_ref=$2 AND offer_ref=$3
         AND mapping_state='Active' AND availability='Available'`,
      [productRef, variantRef, offerRef],
    );
    const exactDesiredLine = await ordersAdmin.query(
      `SELECT quantity_milli::text AS quantity FROM orders.cart_desired_lines
       WHERE cart_scope_ref='aroma-primary' AND desired_revision=2 AND offer_ref=$1`,
      [offerRef],
    );
    requireProof(
      exactOrder.rows[0]?.count === 2 &&
        exactMapping.rows[0]?.count === 1 &&
        exactDesiredLine.rows[0]?.quantity === "2000",
      "BACKUP_RECOVERY_FIXTURE_OWNER_ROWS_MISSING",
    );
    const completed = await ordersAdmin.query(
      `SELECT count(*)::int AS count FROM orders.convergence_attempts
       WHERE state='NoOpInSync' AND cart_scope_ref='aroma-primary'`,
    );
    const interruptedAttempt = recoveryFixtureRef(
      "att",
      `${runId}:unfinished-attempt`,
    );
    const unfinished = await ordersAdmin.query(
      "SELECT state FROM orders.convergence_attempts WHERE attempt_ref=$1",
      [interruptedAttempt],
    );
    const unknown = await ordersAdmin.query(
      `SELECT a.state AS attempt_state,r.state AS reservation_state,r.operation_ref,
       r.offer_ref,r.desired_milli::text AS desired_milli
       FROM orders.convergence_attempts a JOIN orders.mutation_reservations r USING(attempt_ref)
       WHERE a.desired_revision=2 AND r.state='UnknownOutcome'
       ORDER BY a.started_at DESC LIMIT 1`,
    );
    requireProof(
      completed.rows[0]?.count >= 1 &&
        unfinished.rows[0]?.state === "Started" &&
        unknown.rows[0]?.attempt_state === "UnknownOutcome" &&
        unknown.rows[0]?.reservation_state === "UnknownOutcome" &&
        unknown.rows[0]?.offer_ref === offerRef &&
        unknown.rows[0]?.desired_milli === "2000",
      "BACKUP_RECOVERY_FIXTURE_ATTEMPTS_MISSING",
    );
    const inbox = await queryRecoveryInboxByMessageIds(ordersAdmin, [
      recoveryFixtureRef("msg", `${runId}:inbox`),
      recoveryFixtureRef("msg", `${runId}:inbox-completed`),
    ]);
    const inboxById = new Map(inbox.rows.map((row) => [row.message_id, row]));
    const completedInbox = inboxById.get(
      recoveryFixtureRef("msg", `${runId}:inbox-completed`),
    );
    const pendingInbox = inboxById.get(
      recoveryFixtureRef("msg", `${runId}:inbox`),
    );
    requireProof(
      completedInbox?.state === "Processed" &&
        pendingInbox?.state === "Processing" &&
        inbox.rows.length === 2,
      "BACKUP_RECOVERY_FIXTURE_INBOX_MISSING",
    );
    const outbox = await ordersAdmin.query(
      `SELECT message_id,state FROM orders.outbox_messages WHERE message_id = ANY($1::text[])`,
      [
        [
          recoveryFixtureRef("msg", `${runId}:outbox:completed`),
          recoveryFixtureRef("msg", `${runId}:outbox:pending`),
        ],
      ],
    );
    const outboxById = new Map(
      outbox.rows.map((row) => [row.message_id, row.state]),
    );
    const completedOutboxId = recoveryFixtureRef(
      "msg",
      `${runId}:outbox:completed`,
    );
    const pendingOutboxId = recoveryFixtureRef(
      "msg",
      `${runId}:outbox:pending`,
    );
    requireProof(
      outboxById.get(completedOutboxId) === "Published" &&
        outboxById.get(pendingOutboxId) === "Pending" &&
        outbox.rows.length === 2,
      "BACKUP_RECOVERY_FIXTURE_OUTBOX_MISSING",
    );
    orderFacts = {
      orderRef,
      offerRef,
      productRef,
      variantRef,
      desiredHash: expectedPlan.hash,
      completedAttemptCount: completed.rows[0].count,
      interruptedAttempt,
      operationRef: unknown.rows[0].operation_ref,
      inbox: {
        completedMessageId: completedInbox.message_id,
        completedEnvelope: completedInbox.envelope,
        pendingMessageId: pendingInbox.message_id,
        pendingEnvelope: pendingInbox.envelope,
      },
      outbox: {
        completedMessageId: completedOutboxId,
        pendingMessageId: pendingOutboxId,
      },
    };
  } finally {
    await Promise.allSettled([
      orders.resource.stop(AbortSignal.timeout(5_000)),
      ordersAdmin.end(),
    ]);
  }

  const integrationName = sourceDatabases.integration;
  const integration = await openDatabase(
    createDatabase,
    optionsFor(
      integrationName,
      "aroma-gateway",
      config,
      target,
      runtimeCredentials["aroma-gateway"],
    ),
    signal,
  );
  try {
    const { ProviderMutationJournalStore } =
      await import("../../../../apps/aroma-gateway/dist/infrastructure/database/provider-mutation-journal.js");
    const journal = new ProviderMutationJournalStore(integration);
    const operationRef = recoveryFixtureRef("op", `${runId}:gateway-operation`);
    const record = await journal.get(operationRef, signal);
    requireProof(
      record?.state === "UnknownOutcome" &&
        record.operationRef === operationRef,
      "BACKUP_RECOVERY_FIXTURE_GATEWAY_JOURNAL_MISSING",
    );
    return {
      orders: orderFacts,
      gateway: {
        operationRef,
        request: {
          operationRef,
          cartScopeRef: record.cartScopeRef,
          operationKind: record.operationKind,
          offerRef: record.offerRef,
          ...(record.quantityMilli === null
            ? {}
            : { quantityMilli: record.quantityMilli }),
          ...(record.sourceGrindKeyHash === null
            ? {}
            : { sourceGrindKeyHash: record.sourceGrindKeyHash }),
        },
        delegation: {
          transportCaller: "api-internal",
          issuer: "api-internal",
          audience: "aroma-gateway",
          originalCaller: record.originalCaller,
          operationId: record.operationId,
          callerIdentity: record.callerIdentity,
          correlationId: record.correlationId,
          ...(record.traceparent === null
            ? {}
            : { traceparent: record.traceparent }),
        },
      },
    };
  } finally {
    await integration.resource.stop(AbortSignal.timeout(5_000)).catch(() => {});
  }
}

export async function proveRecoveryAfterRestore({
  target,
  password,
  runtimeCredentials,
  config,
  restoreDatabases,
  runId,
  fixtures,
  signal,
}) {
  const { createDatabase } =
    await import("../../../../packages/platform-database/dist/index.js");
  const { withTransaction } =
    await import("../../../../packages/platform-database/dist/index.js");
  const { createSqlInboxStore, consumeOnce } =
    await import("../../../../packages/platform-inbox/dist/index.js");
  const { createSqlOutboxStore, relayOutboxBatch } =
    await import("../../../../packages/platform-outbox/dist/index.js");
  const { createAromaConvergenceStore } =
    await import("../../../../apps/aroma-convergence/dist/infrastructure/convergence-store.js");
  const { createAromaPreparationStore } =
    await import("../../../../apps/orders-aroma-preparation/dist/infrastructure/preparation-store.js");
  const { ProviderMutationJournalStore } =
    await import("../../../../apps/aroma-gateway/dist/infrastructure/database/provider-mutation-journal.js");
  const { GatewayMutationExecutor } =
    await import("../../../../apps/aroma-gateway/dist/domain/mutation-journal.js");
  const { canonicalRequestHash } =
    await import("../../../../packages/platform-idempotency/dist/index.js");
  const results = {};
  const ordersName = restoreDatabases.orders;
  const orders = await openDatabase(
    createDatabase,
    optionsFor(
      ordersName,
      "aroma-convergence",
      config,
      target,
      runtimeCredentials["aroma-convergence"],
    ),
    signal,
  );
  const preparationDb = await openDatabase(
    createDatabase,
    optionsFor(
      ordersName,
      "orders-aroma-preparation",
      config,
      target,
      runtimeCredentials["orders-aroma-preparation"],
    ),
    signal,
  );
  const ordersAdmin = await openAdminClient(
    target.host,
    target.port,
    ordersName,
    password,
    signal,
  );
  try {
    const convergenceSettings = parseYaml(
      await readFile(
        new URL("../../../../config/platform.yaml", import.meta.url),
        "utf8",
      ),
      { json: true },
    ).services["aroma-convergence"].aromaConvergence;
    const ownerId = randomUUID();
    const convergence = createAromaConvergenceStore(orders, {
      ownerInstanceId: ownerId,
      mutationsEnabled: true,
      ...convergenceSettings,
    });
    await convergence.recover(signal);
    const trace = [];
    const barrier = await ordersAdmin.query(
      "SELECT reserved_until AS until FROM orders.mutation_reservations WHERE operation_ref=$1",
      [fixtures.orders.operationRef],
    );
    const until =
      barrier.rows[0]?.until instanceof Date
        ? barrier.rows[0].until.getTime()
        : Date.parse(barrier.rows[0]?.until);
    if (!Number.isFinite(until))
      throw Object.assign(new Error("BACKUP_RESTORE_RECOVERY_WINDOW_MISSING"), {
        code: "BACKUP_RESTORE_RECOVERY_WINDOW_MISSING",
      });
    const waitMs = until - Date.now() + 50;
    if (waitMs > 10 * 60_000)
      requireProof(false, "BACKUP_RECOVERY_WINDOW_EXCEEDS_LIMIT");
    if (waitMs > 0) await waitFor(waitMs, signal);
    const targetLine = { offerRef: fixtures.orders.offerRef, quantity: "2" };
    const snapshot = {
      cartScopeRef: "aroma-primary",
      capturedAt: new Date().toISOString(),
      providerSnapshotRef: `aroma-gateway:cart-body-sha256:${sha(JSON.stringify([targetLine]))}`,
      cartFingerprint: sha(JSON.stringify([targetLine])),
      lines: [targetLine],
    };
    const gateway = {
      catalogInput: async () => ({
        productRef: fixtures.orders.productRef,
        variantRef: fixtures.orders.variantRef,
        offerRef: fixtures.orders.offerRef,
        snapshotRevision: "1",
        supplierUnitMinor: "1",
        currency: "RUB",
        unit: "piece",
        availability: "Available",
        mappingRevision: "1",
        displayName: "backup_restore fixture",
      }),
      read: async () => {
        trace.push({ kind: "GET" });
        return snapshot;
      },
      setQuantity: async (_offer, request) => {
        trace.push({ kind: "MUTATION", operationRef: request.operationRef });
        throw new Error("unexpected backup_restore recovery mutation");
      },
      remove: async (_offer, request) => {
        trace.push({ kind: "MUTATION", operationRef: request.operationRef });
        throw new Error("unexpected backup_restore recovery mutation");
      },
    };
    await convergence.runOnce(gateway, signal);
    const orderFacts = await ordersAdmin.query(
      `SELECT a.state AS attempt_state,r.state AS reservation_state,r.operation_ref
      FROM orders.convergence_attempts a JOIN orders.mutation_reservations r USING(attempt_ref)
      WHERE r.operation_ref=$1`,
      [fixtures.orders.operationRef],
    );
    const traceProof = verifyRecoveryUnknownOutcomeTrace(
      trace,
      fixtures.orders.operationRef,
    );
    requireProof(
      orderFacts.rows[0]?.reservation_state === "RecoveredApplied",
      "BACKUP_CONVERGENCE_RECOVERY_NOT_APPLIED",
    );
    const attemptRecovery = await ordersAdmin.query(
      "SELECT state FROM orders.convergence_attempts WHERE attempt_ref=$1",
      [fixtures.orders.interruptedAttempt],
    );
    const completedHistory = await ordersAdmin.query(
      "SELECT count(*)::int AS count FROM orders.convergence_attempts WHERE state='NoOpInSync'",
    );
    requireProof(
      attemptRecovery.rows[0]?.state === "Failed" &&
        completedHistory.rows[0]?.count >=
          fixtures.orders.completedAttemptCount,
      "BACKUP_ATTEMPT_HISTORY_RECOVERY_FAILED",
    );
    results.convergence = {
      ...traceProof,
      reservationState: orderFacts.rows[0].reservation_state,
      interruptedAttemptState: attemptRecovery.rows[0].state,
      completedAttemptsPreserved: true,
    };

    const preparation = createAromaPreparationStore(preparationDb, {
      ...parseYaml(
        await readFile(
          new URL("../../../../config/platform.yaml", import.meta.url),
          "utf8",
        ),
        { json: true },
      ).services["orders-aroma-preparation"].aromaPreparation,
      maxSnapshotAgeMs: convergenceSettings.maxSnapshotAgeMs,
    });
    await preparation.recover(signal);
    const preparationProjection = await ordersAdmin.query(
      `SELECT desired_revision::text AS desired_revision,desired_hash,state
       FROM orders.order_aroma_projections WHERE order_ref=$1`,
      [fixtures.orders.orderRef],
    );
    requireProof(
      preparationProjection.rows[0]?.desired_revision === "2" &&
        preparationProjection.rows[0]?.desired_hash ===
          fixtures.orders.desiredHash,
      "BACKUP_PREPARATION_RECOVERY_FAILED",
    );
    results.preparation = {
      desiredRevision: preparationProjection.rows[0].desired_revision,
      desiredHash: preparationProjection.rows[0].desired_hash,
      projectionState: preparationProjection.rows[0].state,
    };

    const inbox = createSqlInboxStore(orders, {
      schema: "orders",
      consumerName: "g17-backup-restore-v1",
    });
    const pendingEnvelope = fixtures.orders.inbox.pendingEnvelope;
    let handled = 0;
    const pendingMessage = {
      messageId: pendingEnvelope.messageId,
      messageType: pendingEnvelope.messageType,
      receivedAt: pendingEnvelope.occurredAt,
      payloadHash: canonicalRequestHash(pendingEnvelope),
      payload: pendingEnvelope,
    };
    const pendingResult = await withTransaction(
      orders,
      { mode: "background", signal },
      (tx) =>
        consumeOnce(
          inbox,
          tx,
          pendingMessage,
          "g17-backup-restore-v1",
          Date.now(),
          30_000,
          async () => {
            handled++;
          },
          new Date().toISOString(),
        ),
    );
    requireProof(
      pendingResult.kind === "processed" && handled === 1,
      "BACKUP_INBOX_PENDING_RECOVERY_FAILED",
    );
    const completedEnvelope = fixtures.orders.inbox.completedEnvelope;
    const completedMessage = {
      messageId: completedEnvelope.messageId,
      messageType: completedEnvelope.messageType,
      receivedAt: completedEnvelope.occurredAt,
      payloadHash: canonicalRequestHash(completedEnvelope),
      payload: completedEnvelope,
    };
    let duplicateHandled = 0;
    const duplicate = await withTransaction(
      orders,
      { mode: "background", signal },
      (tx) =>
        consumeOnce(
          inbox,
          tx,
          completedMessage,
          "g17-backup-restore-v1",
          Date.now(),
          30_000,
          async () => {
            duplicateHandled++;
          },
          new Date().toISOString(),
        ),
    );
    requireProof(
      duplicate.kind === "duplicate" && duplicateHandled === 0,
      "BACKUP_INBOX_COMPLETED_REPLAYED",
    );
    results.inbox = {
      unfinished: "resumed",
      completedDuplicate: duplicate.kind,
    };

    const outbox = createSqlOutboxStore(orders, {
      schema: "orders",
      envelopeBytes: true,
      topics: ["coffee.orders.lifecycle.v1"],
    });
    const relay = await relayOutboxBatch(
      outbox,
      orders,
      async () => ({ kind: "ack" }),
      {
        nowMs: Date.now(),
        leaseOwner: "g17-restored-worker",
        policy: {
          leaseMs: 30_000,
          sendTimeoutMs: 5_000,
          maxInFlight: 1,
          retry: { baseMs: 1_000, maxMs: 5_000, maxAttempts: 3 },
        },
        signal,
      },
    );
    requireProof(
      relay.published === 1 && relay.failed === 0 && relay.unknown === 0,
      "BACKUP_OUTBOX_PENDING_RECOVERY_FAILED",
    );
    results.outbox = relay;
  } finally {
    await Promise.allSettled([
      orders.resource.stop(AbortSignal.timeout(5_000)),
      preparationDb.resource.stop(AbortSignal.timeout(5_000)),
      ordersAdmin.end(),
    ]);
  }

  const integrationName = restoreDatabases.integration;
  const integration = await openDatabase(
    createDatabase,
    optionsFor(
      integrationName,
      "aroma-gateway",
      config,
      target,
      runtimeCredentials["aroma-gateway"],
    ),
    signal,
  );
  try {
    const journal = new ProviderMutationJournalStore(integration);
    await journal.recoverAfterRestart(undefined, signal);
    let dispatches = 0;
    const executor = new GatewayMutationExecutor(journal, async () => {
      dispatches++;
      throw new Error("old backup_restore operation must not dispatch");
    });
    const replay = await executor.execute(
      fixtures.gateway.request,
      fixtures.gateway.delegation,
      signal,
    );
    requireProof(
      replay.state === "UnknownOutcome" &&
        replay.replayed === true &&
        dispatches === 0,
      "BACKUP_GATEWAY_UNKNOWN_REPLAY_DISPATCHED",
    );
    results.gateway = {
      state: replay.state,
      replayed: replay.replayed,
      dispatches,
    };
  } finally {
    await integration.resource.stop(AbortSignal.timeout(5_000)).catch(() => {});
  }
  return { status: "PASS", runId, recovery: results };
}
