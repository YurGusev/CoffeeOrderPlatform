import type { IncomingMessage, ServerResponse } from "node:http";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview, type PreviewServer } from "vite";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";
import { expect } from "playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const appRoot = resolve(repoRoot, "apps/web");
const port = Number(process.env.WEB_OPERATOR_PORT ?? "4175");
const origin = `http://localhost:${port}`;
const customerRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const quoteRef = "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const policyVersionRef = "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const timestamp = "2026-09-28T12:00:00.000Z";
const correlationPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hash = "a".repeat(64);
const grindHash = "b".repeat(64);
const replacementGrindHash = "c".repeat(64);
const screenshotDir = process.env.WEB_SCREENSHOT_DIR;

async function capture(page: Page, name: string): Promise<void> {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: resolve(screenshotDir, name) });
}

export function customerSummary() {
  return {
    customerRef,
    version: "1",
    displayName: "Иван Петров",
    phone: "+79999994567",
  };
}

function customerResponse() {
  return { ...customerSummary(), createdAt: timestamp, updatedAt: timestamp };
}

export function orderCard(
  version = "1",
  status: "Draft" | "Confirmed" = "Draft",
  withItem = false,
  aromaState:
    | "NotRequested"
    | "PendingObservation"
    | "OutOfSync"
    | "Converging"
    | "InSync"
    | "Blocked"
    | "UnknownOutcome" = status === "Confirmed"
    ? "PendingObservation"
    : "NotRequested",
  sourceGrindKeyHash?: string,
  aromaBlockerCode:
    "MAPPING_MISSING" | "AROMA_QUANTITY_NOT_SUPPORTED" = "MAPPING_MISSING",
) {
  return {
    orderRef,
    version,
    projectionVersion: version,
    status,
    customer: { customerRef, displayName: "Иван Петров" },
    items: withItem
      ? [
          {
            itemRef: "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            linePosition: 1,
            productRef,
            variantRef,
            displayName: "Капучино",
            quantity: "2",
            unit: "piece",
            quoteRef,
            quoteLineNumber: 1,
            unitMinor: "25000",
            lineTotalMinor: "50000",
            ...(sourceGrindKeyHash
              ? { sourceGrindKeyHash, grindDisplayName: "Мелкий помол" }
              : {}),
          },
        ]
      : [],
    pricing: withItem
      ? {
          totalMinor: "50000",
          currency: "RUB",
          quoteProofs: [
            { quoteRef, hash, expiresAt: "2030-01-01T00:10:00.000Z" },
          ],
        }
      : null,
    aroma: {
      state: aromaState,
      desiredRevision: status === "Confirmed" ? "1" : "0",
      observedRevision: "0",
      blockers:
        aromaState === "Blocked"
          ? [
              {
                code: aromaBlockerCode,
                message:
                  aromaBlockerCode === "AROMA_QUANTITY_NOT_SUPPORTED"
                    ? "Количество нельзя безопасно передать в AROMA"
                    : "Для позиции отсутствует безопасное сопоставление",
              },
            ]
          : [],
    },
    allowedActions:
      status === "Draft"
        ? ["edit-items", "confirm"]
        : ["Blocked", "UnknownOutcome"].includes(aromaState)
          ? []
          : ["request-aroma-reconciliation"],
  };
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers,
    status,
  });
}

async function captureBrowserTelemetry(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as Window & { __coffeeTelemetry?: unknown[] };
    scope.__coffeeTelemetry = [];
    window.addEventListener("coffee:browser-telemetry", (event) => {
      scope.__coffeeTelemetry?.push((event as CustomEvent).detail);
    });
  });
}

type BrowserTelemetryEvent = Readonly<{
  correlationId: string;
  durationMs: number;
  endpoint: string;
  name: string;
  result: string;
  route: string;
}>;

async function browserTelemetry(page: Page): Promise<BrowserTelemetryEvent[]> {
  return page.evaluate(
    () =>
      (window as Window & { __coffeeTelemetry?: BrowserTelemetryEvent[] })
        .__coffeeTelemetry ?? [],
  );
}

type MockTelemetry = Readonly<{
  correlationFailures: string[];
  draftRequests: Array<
    Readonly<{
      body: string | null;
      key: string | undefined;
      replayOnly: boolean;
    }>
  >;
  putReplayOnly: boolean[];
  logoutRequests: string[];
  quoteRequests: string[];
  putRequests: string[];
  putIntentKeys: string[];
  reconciliationReasons: string[];
  reconciliationExpectedVersions: string[];
  reconciliationKeys: string[];
  advanceReconciliationProjection: () => void;
  releaseReconciliationRefresh: () => void;
  releaseFirstPut: () => void;
  releaseCatalogRefetch: () => void;
  armCustomerFailure: () => void;
  armCatalogFailure: () => void;
  clearSearchFailures: () => void;
  armOrderFailure: () => void;
  setSessionAvailable: (available: boolean) => void;
  switchActor: () => void;
}>;

async function installCommonMocks(
  page: Page,
  options: {
    nativeRealtime?: boolean;
    abortFirstDraft?: boolean;
    abortFirstPut?: boolean;
    holdFirstPut?: boolean;
    aromaBlocker?: "MAPPING_MISSING" | "AROMA_QUANTITY_NOT_SUPPORTED";
    aromaScenario?: "Blocked" | "UnknownOutcome";
    catalogUnavailable?: boolean;
    catalogNextCursor?: boolean;
    catalogRefetchFailure?: Readonly<{ query: string; status: 403 | 503 }>;
    catalogRefetchFailureSequence?: Readonly<{
      query: string;
      statuses: readonly (200 | 403 | 503)[];
    }>;
    conflictPut?: boolean;
    customerNextCursor?: boolean;
    customersUnavailable?: boolean;
    grindSelectionRefresh?: boolean;
    customerValidationError?: boolean;
    customerRefetchFailureSequence?: Readonly<{
      query: string;
      statuses: readonly (200 | 403 | 503)[];
    }>;
    draftStatusMismatch?: boolean;
    expiredSession?: boolean;
    expiredDraftQuote?: boolean;
    forbiddenCustomers?: boolean;
    forbiddenCustomerQueryOnRefetch?: string;
    holdReconciliationRefresh?: boolean;
    initialItem?: boolean;
    initialItemGrind?: boolean;
    malformedCustomers?: boolean;
    orderNotFound?: boolean;
    orderUnavailable?: boolean;
    orderFailureOnRefetch?: 403 | 404 | 503;
    orderFailureSequence?: readonly (403 | 404 | 503 | "divergent-200")[];
    orderRefetchUnavailableAfterConflict?: boolean;
    conflictRefetchConfirmed?: boolean;
    allowUnknownOutcomeReconciliation?: boolean;
    pricingUnavailable?: boolean;
    reconciliationRefreshFails?: boolean;
    replayWrongTerminal?: boolean;
    sessionUnavailable?: boolean;
    staleGrind?: boolean;
    stalePut?: boolean;
  } = {},
): Promise<MockTelemetry> {
  let draftAttempt = 0;
  let firstPutAborted = false;
  let firstPutHeld = false;
  let releaseFirstPut = (): void => undefined;
  const firstPutGate = options.holdFirstPut
    ? new Promise<void>((resolve) => {
        releaseFirstPut = resolve;
      })
    : Promise.resolve();
  let customerFailureArmed = false;
  let customerFailureSequenceIndex = 0;
  let catalogFailureArmed = false;
  let catalogFailureSequenceIndex = 0;
  let releaseCatalogRefetch = (): void => undefined;
  const catalogRefetchGate = new Promise<void>((resolve) => {
    releaseCatalogRefetch = resolve;
  });
  let orderCardReads = 0;
  let orderFailureArmed = false;
  let orderFailureSequenceIndex = 0;
  let orderRefetchFailuresRemaining = 0;
  let grindOptionSearchCount = 0;
  let current = options.aromaScenario
    ? orderCard(
        "5",
        "Confirmed",
        true,
        options.aromaScenario,
        options.initialItemGrind ? grindHash : undefined,
        options.aromaBlocker,
      )
    : options.initialItem
      ? orderCard(
          options.conflictPut ? "1" : "2",
          "Draft",
          true,
          "NotRequested",
          options.initialItemGrind ? grindHash : undefined,
        )
      : orderCard();
  if (options.expiredDraftQuote && current.pricing) {
    current = {
      ...current,
      allowedActions: ["edit-items"],
      pricing: {
        ...current.pricing,
        quoteProofs: current.pricing.quoteProofs.map((proof) => ({
          ...proof,
          expiresAt: "2020-01-01T00:00:00.000Z",
        })),
      },
    };
  }
  if (options.allowUnknownOutcomeReconciliation)
    current = { ...current, allowedActions: ["request-aroma-reconciliation"] };
  let reconciliationAccepted = false;
  let activeActor = "operator-1";
  let sessionAvailable = true;
  let loggedOut = false;
  const quoteRequests: string[] = [];
  const putRequests: string[] = [];
  const putIntentKeys: string[] = [];
  const putReplayOnly: boolean[] = [];
  let quotedCanonicalQuantity = "2";
  const reconciliationExpectedVersions: string[] = [];
  const reconciliationKeys: string[] = [];
  let releaseReconciliationRefresh = (): void => undefined;
  const reconciliationRefreshGate = options.holdReconciliationRefresh
    ? new Promise<void>((resolve) => {
        releaseReconciliationRefresh = resolve;
      })
    : Promise.resolve();
  const telemetry: MockTelemetry = {
    correlationFailures: [],
    draftRequests: [],
    logoutRequests: [],
    quoteRequests,
    putRequests,
    putIntentKeys,
    putReplayOnly,
    reconciliationReasons: [],
    reconciliationExpectedVersions,
    reconciliationKeys,
    advanceReconciliationProjection: () => {
      current = {
        ...orderCard("5", "Confirmed", true, "OutOfSync"),
        projectionVersion: "6",
      };
    },
    releaseReconciliationRefresh: () => releaseReconciliationRefresh(),
    releaseFirstPut: () => releaseFirstPut(),
    releaseCatalogRefetch: () => releaseCatalogRefetch(),
    armCustomerFailure: () => {
      customerFailureArmed = true;
    },
    armCatalogFailure: () => {
      catalogFailureArmed = true;
    },
    clearSearchFailures: () => {
      customerFailureArmed = false;
      catalogFailureArmed = false;
    },
    armOrderFailure: () => {
      orderFailureArmed = true;
    },
    setSessionAvailable: (available) => {
      sessionAvailable = available;
    },
    switchActor: () => {
      activeActor = "operator-2";
    },
  };
  await page.route("**/auth/session", (route) => {
    if (
      !correlationPattern.test(
        route.request().headers()["x-correlation-id"] ?? "",
      )
    )
      telemetry.correlationFailures.push("/auth/session");
    if (options.sessionUnavailable)
      return fulfillJson(
        route,
        {
          type: "about:blank",
          title: "Authorization unavailable",
          status: 503,
          code: "AUTHORIZATION_UNAVAILABLE",
          detail: "Session service unavailable",
          instance: "/auth/session",
          correlationId: "00000000-0000-4000-8000-000000000008",
          errors: [],
        },
        503,
      );
    return loggedOut || !sessionAvailable
      ? fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Authentication required",
            status: 401,
            code: "AUTHENTICATION_REQUIRED",
            detail: "Session ended",
            instance: "/auth/session",
            correlationId: "00000000-0000-4000-8000-000000000005",
            errors: [],
          },
          401,
        )
      : fulfillJson(route, {
          actorRef: activeActor,
          expiresAt: options.expiredSession
            ? "2020-01-01T00:00:00.000Z"
            : "2030-01-01T00:00:00.000Z",
        });
  });
  await page.route("**/auth/logout", async (route) => {
    if (
      !correlationPattern.test(
        route.request().headers()["x-correlation-id"] ?? "",
      )
    )
      telemetry.correlationFailures.push("/auth/logout");
    telemetry.logoutRequests.push(route.request().method());
    loggedOut = true;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/client-v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!correlationPattern.test(request.headers()["x-correlation-id"] ?? ""))
      telemetry.correlationFailures.push(url.pathname);
    const method = request.method();
    if (url.pathname === "/api/client-v1/customers" && method === "GET") {
      const forbiddenCustomerRefetch =
        customerFailureArmed &&
        options.forbiddenCustomerQueryOnRefetch ===
          url.searchParams.get("query");
      const customerSequenceMatches =
        customerFailureArmed &&
        options.customerRefetchFailureSequence?.query ===
          url.searchParams.get("query");
      const customerFailureStatus = customerSequenceMatches
        ? options.customerRefetchFailureSequence?.statuses[
            Math.min(
              customerFailureSequenceIndex++,
              (options.customerRefetchFailureSequence?.statuses.length ?? 1) -
                1,
            )
          ]
        : forbiddenCustomerRefetch
          ? 403
          : undefined;
      if (options.customersUnavailable)
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Customer unavailable",
            status: 503,
            code: "CUSTOMER_UNAVAILABLE",
            detail: "Поиск клиентов временно недоступен",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000010",
            errors: [],
          },
          503,
        );
      if (options.forbiddenCustomers || customerFailureStatus === 403)
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Forbidden",
            status: 403,
            code: "AUTHORIZATION_FORBIDDEN",
            detail: "Actor cannot read customers",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000009",
            errors: [],
          },
          403,
        );
      if (customerFailureStatus === 503)
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Customer unavailable",
            status: 503,
            code: "CUSTOMER_UNAVAILABLE",
            detail: "Поиск клиентов временно недоступен",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000010",
            errors: [],
          },
          503,
        );
      if (options.malformedCustomers)
        return fulfillJson(route, { items: "invalid", nextCursor: null });
      return fulfillJson(route, {
        items: [customerSummary()],
        nextCursor: options.customerNextCursor ? "customer-next-page" : null,
      });
    }
    if (url.pathname === "/api/client-v1/customers" && method === "POST") {
      if (options.customerValidationError) {
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Validation failed",
            status: 400,
            code: "VALIDATION_FAILED",
            detail: "Некорректное имя клиента",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000002",
            errors: [
              {
                field: "/displayName",
                code: "INVALID",
                message: "Исправьте имя клиента",
              },
            ],
          },
          400,
        );
      }
      return fulfillJson(route, customerResponse(), 201);
    }
    if (url.pathname === "/api/client-v1/orders/drafts" && method === "POST") {
      draftAttempt += 1;
      telemetry.draftRequests.push({
        body: request.postData(),
        key: request.headers()["idempotency-key"],
        replayOnly: request.headers()["idempotency-replay-only"] === "true",
      });
      if (options.abortFirstDraft && draftAttempt === 1)
        return route.abort("connectionfailed");
      if (options.draftStatusMismatch) {
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Validation failed",
            status: 400,
            code: "VALIDATION_FAILED",
            detail: "Mismatched transport status",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000006",
            errors: [],
          },
          500,
        );
      }
      const replayed = request.headers()["idempotency-replay-only"] === "true";
      if (options.replayWrongTerminal && replayed) {
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Item not found",
            status: 404,
            code: "ORDER_ITEM_NOT_FOUND",
            detail:
              "Сохранённый ответ не соответствует команде создания заказа",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000014",
            errors: [],
          },
          404,
          { "Idempotency-Replayed": "true" },
        );
      }
      current = orderCard();
      return fulfillJson(
        route,
        current,
        201,
        replayed ? { "Idempotency-Replayed": "true" } : {},
      );
    }
    if (
      url.pathname === `/api/client-v1/orders/${orderRef}` &&
      method === "GET"
    ) {
      orderCardReads += 1;
      const sequencedRead =
        orderFailureArmed && options.orderFailureSequence
          ? options.orderFailureSequence[orderFailureSequenceIndex++]
          : undefined;
      if (sequencedRead === "divergent-200") {
        return fulfillJson(route, {
          ...orderCard("2", "Confirmed", true),
          projectionVersion: "2",
        });
      }
      const status = sequencedRead ?? options.orderFailureOnRefetch;
      if (orderFailureArmed && orderCardReads > 1 && status) {
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title:
              status === 403
                ? "Forbidden"
                : status === 404
                  ? "Order not found"
                  : "Order unavailable",
            status,
            code:
              status === 403
                ? "AUTHORIZATION_FORBIDDEN"
                : status === 404
                  ? "ORDER_NOT_FOUND"
                  : "ORDER_UNAVAILABLE",
            detail:
              status === 403
                ? "Actor cannot read order"
                : status === 404
                  ? "Заказ не найден"
                  : "Текущее состояние заказа временно недоступно",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000016",
            errors: [],
          },
          status,
        );
      }
      if (options.holdReconciliationRefresh && reconciliationAccepted)
        await reconciliationRefreshGate;
      if (options.orderNotFound)
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Order not found",
            status: 404,
            code: "ORDER_NOT_FOUND",
            detail: "Заказ не найден",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000013",
            errors: [],
          },
          404,
        );
      const failConflictRefetch = orderRefetchFailuresRemaining > 0;
      if (failConflictRefetch) orderRefetchFailuresRemaining -= 1;
      if (
        failConflictRefetch ||
        options.orderUnavailable ||
        (options.reconciliationRefreshFails && reconciliationAccepted)
      ) {
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Order unavailable",
            status: 503,
            code: "ORDER_UNAVAILABLE",
            detail: "Текущее состояние заказа временно недоступно",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000007",
            errors: [],
          },
          503,
        );
      }
      return fulfillJson(route, current);
    }
    if (
      url.pathname === "/api/client-v1/catalog/products" &&
      method === "GET"
    ) {
      const catalogSequenceMatches =
        catalogFailureArmed &&
        options.catalogRefetchFailureSequence?.query ===
          url.searchParams.get("query");
      const sequencedCatalogStatus = catalogSequenceMatches
        ? options.catalogRefetchFailureSequence?.statuses[
            Math.min(
              catalogFailureSequenceIndex++,
              (options.catalogRefetchFailureSequence?.statuses.length ?? 1) - 1,
            )
          ]
        : undefined;
      const catalogFailureStatus =
        sequencedCatalogStatus ??
        (catalogFailureArmed &&
        options.catalogRefetchFailure?.query === url.searchParams.get("query")
          ? options.catalogRefetchFailure.status
          : options.catalogUnavailable
            ? 503
            : undefined);
      if (catalogFailureStatus === 403 || catalogFailureStatus === 503) {
        if (
          catalogSequenceMatches ||
          (catalogFailureArmed &&
            options.catalogRefetchFailure?.query ===
              url.searchParams.get("query"))
        )
          await catalogRefetchGate;
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title:
              catalogFailureStatus === 403
                ? "Forbidden"
                : "Catalog unavailable",
            status: catalogFailureStatus,
            code:
              catalogFailureStatus === 403
                ? "AUTHORIZATION_FORBIDDEN"
                : "CATALOG_UNAVAILABLE",
            detail:
              catalogFailureStatus === 403
                ? "Actor cannot read catalog"
                : "Каталог временно недоступен",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000011",
            errors: [],
          },
          catalogFailureStatus,
        );
      }
      let grindOptions = [
        { sourceGrindKeyHash: grindHash, displayName: "Мелкий помол" },
      ];
      if (options.grindSelectionRefresh) {
        grindOptionSearchCount += 1;
        if (grindOptionSearchCount === 2) grindOptions = [];
        else if (grindOptionSearchCount > 2)
          grindOptions = [
            {
              sourceGrindKeyHash: replacementGrindHash,
              displayName: "Крупный помол B",
            },
          ];
      }
      return fulfillJson(route, {
        snapshotRevision: "7",
        items: [
          {
            productRef,
            variantRef,
            displayName: "Капучино",
            unit: "piece",
            availability: "Available",
            mappingAvailable: true,
            grindOptions,
          },
        ],
        nextCursor: options.catalogNextCursor ? "catalog-next-page" : null,
      });
    }
    if (url.pathname === "/api/client-v1/pricing/quotes" && method === "POST") {
      quoteRequests.push(request.postData() ?? "");
      if (options.staleGrind)
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Grind unavailable",
            status: 422,
            code: "PRICING_GRIND_NOT_AVAILABLE",
            detail: "Выбранный помол больше недоступен",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000015",
            errors: [],
          },
          422,
        );
      if (options.pricingUnavailable)
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Pricing unavailable",
            status: 503,
            code: "PRICING_POLICY_UNAVAILABLE",
            detail: "Расчёт цены временно недоступен",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000012",
            errors: [],
          },
          503,
        );
      const quoteRequest = request.postDataJSON() as {
        lines?: Array<{ quantity?: string; sourceGrindKeyHash?: string }>;
      };
      const requestedQuantity = quoteRequest.lines?.[0]?.quantity ?? "2";
      const canonicalQuantity = requestedQuantity.includes(".")
        ? requestedQuantity.replace(/0+$/u, "").replace(/\.$/u, "")
        : requestedQuantity;
      quotedCanonicalQuantity = canonicalQuantity;
      const sourceGrindKeyHash = quoteRequest.lines?.[0]?.sourceGrindKeyHash;
      return fulfillJson(
        route,
        {
          quoteRef,
          policyVersionRef,
          catalogSnapshotRevision: "7",
          customerRef,
          createdAt: timestamp,
          expiresAt: "2030-01-01T00:10:00.000Z",
          currency: "RUB",
          lines: [
            {
              lineNumber: 1,
              productRef,
              variantRef,
              productDisplayName: "Капучино",
              quantity: canonicalQuantity,
              unit: "piece",
              unitMinor: "25000",
              lineTotalMinor: "50000",
              ...(sourceGrindKeyHash
                ? { sourceGrindKeyHash, grindDisplayName: "Мелкий помол" }
                : {}),
            },
          ],
          totalMinor: "50000",
          hash,
        },
        201,
      );
    }
    if (
      /^\/api\/client-v1\/orders\/ord_[^/]+\/items\/itm_[^/]+$/u.test(
        url.pathname,
      ) &&
      method === "PUT"
    ) {
      putRequests.push(request.postData() ?? "");
      putIntentKeys.push(request.headers()["idempotency-key"] ?? "");
      const replayOnly =
        request.headers()["idempotency-replay-only"] === "true";
      putReplayOnly.push(replayOnly);
      if (replayOnly)
        return fulfillJson(route, current, 200, {
          "Idempotency-Replayed": "true",
        });
      if (options.abortFirstPut && !firstPutAborted) {
        firstPutAborted = true;
        current = orderCard("3", "Draft", true);
        return route.abort("connectionfailed");
      }
      if (options.stalePut) {
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Quote is stale",
            status: 409,
            code: "ORDER_QUOTE_STALE",
            detail: "Получите новую цену",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000003",
            errors: [],
          },
          409,
        );
      }
      const putRequest = request.postDataJSON() as {
        expectedVersion?: string;
        quantity?: string;
        sourceGrindKeyHash?: string;
      };
      if (putRequest.quantity !== quotedCanonicalQuantity)
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Quote scope mismatch",
            status: 409,
            code: "ORDER_QUOTE_SCOPE_MISMATCH",
            detail: "PUT quantity must match the selected quote line",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000016",
            errors: [],
          },
          409,
        );
      if (options.conflictPut && putRequest.expectedVersion === "1") {
        if (options.orderRefetchUnavailableAfterConflict)
          orderRefetchFailuresRemaining = 2;
        current = orderCard(
          "4",
          options.conflictRefetchConfirmed ? "Confirmed" : "Draft",
          true,
        );
        return fulfillJson(
          route,
          {
            type: "about:blank",
            title: "Order changed",
            status: 409,
            code: "ORDER_VERSION_CONFLICT",
            detail: "Заказ изменился на сервере",
            instance: url.pathname,
            correlationId: "00000000-0000-4000-8000-000000000004",
            errors: [],
          },
          409,
        );
      }
      current = orderCard(
        options.holdFirstPut
          ? "3"
          : options.expiredDraftQuote
            ? "3"
            : options.conflictPut
              ? "5"
              : "2",
        "Draft",
        true,
        "NotRequested",
        putRequest.sourceGrindKeyHash,
      );
      if (options.holdFirstPut && !firstPutHeld) {
        firstPutHeld = true;
        const accepted = current;
        await firstPutGate;
        return fulfillJson(route, accepted);
      }
      return fulfillJson(route, current);
    }
    if (
      /^\/api\/client-v1\/orders\/ord_[^/]+\/items\/itm_[^/]+$/u.test(
        url.pathname,
      ) &&
      method === "DELETE"
    ) {
      current = orderCard("3", "Draft", false);
      return fulfillJson(route, current);
    }
    if (
      url.pathname === `/api/client-v1/orders/${orderRef}/commands/confirm` &&
      method === "POST"
    ) {
      current = orderCard("3", "Confirmed", true, "OutOfSync");
      return fulfillJson(route, current);
    }
    if (
      url.pathname ===
        `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation` &&
      method === "POST"
    ) {
      const body = request.postDataJSON() as {
        expectedVersion?: string;
        reason?: string;
      };
      telemetry.reconciliationReasons.push(body.reason ?? "");
      reconciliationExpectedVersions.push(body.expectedVersion ?? "");
      reconciliationKeys.push(request.headers()["idempotency-key"] ?? "");
      reconciliationAccepted = true;
      return fulfillJson(
        route,
        {
          orderRef,
          orderVersion: current.version,
          requestedAt: "2026-09-28T18:00:00.000Z",
          aromaState: "PendingObservation",
        },
        202,
      );
    }
    await fulfillJson(
      route,
      {
        type: "about:blank",
        title: "Not found",
        status: 404,
        code: "ORDER_NOT_FOUND",
        detail: "Not found",
        instance: url.pathname,
        correlationId: "00000000-0000-4000-8000-000000000001",
        errors: [],
      },
      404,
    );
  });
  // Non-realtime groups do not emulate a stream; HTTP 204 explicitly stops
  // native reconnect and keeps their established networkidle route helpers.
  if (!options.nativeRealtime)
    await page.route("**/events", (route) => route.fulfill({ status: 204 }));
  return telemetry;
}

async function assertNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(
    (item) => item.impact === "serious" || item.impact === "critical",
  );
  assert.deepEqual(violations, [], `${label}: ${JSON.stringify(violations)}`);
}

async function happyPath(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await captureBrowserTelemetry(page);
  const telemetry = await installCommonMocks(page);
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Клиенты" }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/app/customers");
  const desktopSurface = await page.evaluate(async () => {
    await document.fonts.ready;
    const body = getComputedStyle(document.body);
    const heading = getComputedStyle(
      document.querySelector("h1") as HTMLElement,
    );
    const surface = getComputedStyle(
      document.querySelector(".surface") as HTMLElement,
    );
    return {
      bodyFont: body.fontFamily,
      fontStatus: document.fonts.status,
      headingFont: heading.fontFamily,
      radius: Number.parseFloat(surface.borderRadius),
    };
  });
  assert.equal(desktopSurface.fontStatus, "loaded");
  assert.match(desktopSurface.bodyFont, /Inter/u);
  assert.match(desktopSurface.headingFont, /Manrope/u);
  assert.ok(desktopSurface.radius > 0);
  const focusedHeading = await page.evaluate(() => {
    const heading = document.querySelector(".page-header h1") as HTMLElement;
    const style = getComputedStyle(heading);
    return {
      active: heading === document.activeElement,
      boxShadow: style.boxShadow,
    };
  });
  assert.equal(focusedHeading.active, true);
  assert.notEqual(
    focusedHeading.boxShadow,
    "none",
    "route heading focus должен быть видимым",
  );
  const newCustomerTarget = await page
    .getByRole("button", { name: "Новый клиент" })
    .boundingBox();
  assert.ok(
    newCustomerTarget && newCustomerTarget.height >= 44,
    `desktop target bounds: ${JSON.stringify(newCustomerTarget)}`,
  );
  await capture(page, "customers-1280.png");
  const skipLink = page.getByRole("link", { name: "К основному содержимому" });
  await skipLink.focus();
  assert.equal(
    await skipLink.evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator(":focus").getAttribute("id"),
    "route-content",
  );
  const newCustomerButton = page.getByRole("button", { name: "Новый клиент" });
  await newCustomerButton.click();
  const customerDialog = page.getByRole("dialog", { name: "Новый клиент" });
  const customerName = customerDialog.getByRole("textbox", {
    name: "Имя",
    exact: true,
  });
  await customerName.waitFor();
  assert.equal(
    await customerName.evaluate((node) => node === document.activeElement),
    true,
  );
  await customerName.fill("Иван Петров");
  await page.keyboard.press("Escape");
  assert.equal(
    await customerDialog.isVisible(),
    true,
    "dirty Customer dialog не должен закрываться по Escape",
  );
  await customerDialog
    .getByRole("textbox", { name: "Телефон", exact: true })
    .fill("+79999994567");
  await page.getByRole("button", { name: "Создать и выбрать" }).click();
  await page.getByRole("heading", { name: "Новый заказ" }).waitFor();
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  await page.getByRole("link", { name: "Открыть каталог" }).click();
  await page.getByRole("heading", { name: "Поиск товаров" }).waitFor();
  await page.getByRole("textbox", { name: "Название товара" }).fill("капучино");
  await page.getByRole("button", { name: "Найти" }).click();
  try {
    await page
      .getByRole("heading", { name: "Капучино" })
      .waitFor({ timeout: 5_000 });
  } catch {
    throw new Error(
      `Каталог не показал товар: ${(await page.locator("body").textContent()) ?? ""}`,
    );
  }
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const size = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      size.scroll <= size.client + 1,
      `catalog ${width}px overflow: ${JSON.stringify(size)}`,
    );
    if (width === 375) {
      const addButton = page.getByRole("button", { name: "Добавить" });
      const box = await addButton.boundingBox();
      assert.ok(
        box && box.height >= 44 && box.x >= 0 && box.x + box.width <= width,
        `catalog primary action bounds: ${JSON.stringify(box)}`,
      );
      assert.equal(
        await addButton.evaluate(
          (node) =>
            document.elementFromPoint(
              node.getBoundingClientRect().x +
                node.getBoundingClientRect().width / 2,
              node.getBoundingClientRect().y +
                node.getBoundingClientRect().height / 2,
            ) === node ||
            node.contains(
              document.elementFromPoint(
                node.getBoundingClientRect().x +
                  node.getBoundingClientRect().width / 2,
                node.getBoundingClientRect().y +
                  node.getBoundingClientRect().height / 2,
              ),
            ),
        ),
        true,
      );
    }
    await capture(page, `catalog-${width}.png`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("textbox", { name: "Количество для Капучино" })
    .fill("2");
  await page.getByRole("button", { name: "Добавить" }).click();
  await page.getByRole("link", { name: "К заказу" }).first().click();
  await page.getByText("500,00 ₽").first().waitFor();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Удалить позицию?" });
  await deleteDialog.waitFor();
  await deleteDialog.getByRole("button", { name: "Отмена" }).click();
  const confirmTrigger = page.getByRole("button", {
    name: "Подтвердить заказ",
  });
  await confirmTrigger.click();
  const confirmDialog = page.getByRole("dialog", {
    name: "Подтвердить заказ?",
  });
  const confirmCancel = confirmDialog.getByRole("button", { name: "Отмена" });
  assert.equal(
    await confirmCancel.evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  await confirmDialog.waitFor({ state: "hidden" });
  assert.equal(
    await confirmTrigger.evaluate((node) => node === document.activeElement),
    true,
  );
  await confirmTrigger.click();
  await confirmDialog
    .getByRole("button", { name: "Подтвердить", exact: true })
    .click();
  await page.getByText("Подтверждён").waitFor();
  await page.getByText("Есть расхождение").waitFor();
  try {
    await page
      .getByRole("button", { name: "Запросить сверку AROMA" })
      .click({ timeout: 5_000 });
  } catch {
    throw new Error(
      `Действие сверки не появилось: ${(await page.locator("body").textContent()) ?? ""}`,
    );
  }
  const reconciliationDialog = page.getByRole("dialog", {
    name: "Запросить сверку AROMA?",
  });
  const reconciliationReason = reconciliationDialog.getByRole("textbox", {
    name: "Причина",
  });
  assert.equal(
    await reconciliationReason.evaluate(
      (node) => node === document.activeElement,
    ),
    true,
  );
  await reconciliationReason.fill("Проверка расхождения оператором");
  await page.keyboard.press("Escape");
  assert.equal(
    await reconciliationDialog.isVisible(),
    true,
    "dirty reconciliation dialog не должен закрываться по Escape",
  );
  await reconciliationDialog
    .getByRole("button", { name: "Отправить запрос" })
    .click();
  try {
    await reconciliationDialog.waitFor({ state: "hidden", timeout: 5_000 });
  } catch {
    throw new Error(
      `Диалог сверки не закрылся: ${(await page.locator("body").textContent()) ?? ""}`,
    );
  }
  assert.deepEqual(telemetry.reconciliationReasons, [
    "Проверка расхождения оператором",
  ]);
  await assertNoSeriousA11y(page, "happy path");
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const size = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      size.scroll <= size.client + 1,
      `${width}px overflow: ${JSON.stringify(size)}`,
    );
    if (width === 375 || width === 1280)
      await capture(page, `order-${width}.png`);
  }
  const events = await browserTelemetry(page);
  assert.equal(
    telemetry.correlationFailures.length,
    0,
    `requests without valid X-Correlation-ID: ${telemetry.correlationFailures.join(", ")}`,
  );
  assert.equal(
    events.some((event) => event.name === "ui.query.result"),
    true,
  );
  assert.equal(
    events.some((event) => event.name === "ui.command.result"),
    true,
  );
  assert.equal(
    events.every(
      (event) =>
        correlationPattern.test(event.correlationId) && event.durationMs >= 0,
    ),
    true,
  );
  assert.equal(
    events.some((event) =>
      /\/(?:ord|itm|cus|prd|var|prq|pvr)_/u.test(
        `${event.endpoint}${event.route}`,
      ),
    ),
    false,
  );
  await page.close();
}

async function ambiguousRecovery(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await captureBrowserTelemetry(page);
  const telemetry = await installCommonMocks(page, { abortFirstDraft: true });
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText("Исход команды неизвестен").waitFor();
  assert.equal(telemetry.draftRequests.length, 1);
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText(/уже есть неподтверждённый результат/u).waitFor();
  assert.equal(
    telemetry.draftRequests.length,
    1,
    "повторное обычное создание черновика не должно отправляться",
  );
  await page
    .getByRole("button", { name: "Проверить результат команды" })
    .click();
  await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  assert.equal(telemetry.draftRequests.length, 2);
  assert.equal(
    telemetry.draftRequests[0]?.key,
    telemetry.draftRequests[1]?.key,
  );
  assert.equal(telemetry.draftRequests[0]?.replayOnly, false);
  assert.equal(telemetry.draftRequests[1]?.replayOnly, true);
  assert.notEqual(telemetry.draftRequests[0]?.body, null);
  assert.equal(telemetry.draftRequests[1]?.body, null);
  assert.equal(new URL(page.url()).pathname, `/app/orders/${orderRef}`);
  assert.equal(await page.getByText("Исход команды неизвестен").count(), 0);
  assert.equal(
    (await browserTelemetry(page)).some(
      (event) =>
        event.name === "ui.recovery.result" && event.result === "http:201",
    ),
    true,
  );
  assert.equal(telemetry.correlationFailures.length, 0);
  await page.close();
}

async function actorSwitchBlocksRecovery(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, { abortFirstDraft: true });
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText("Исход команды неизвестен").waitFor();
  telemetry.switchActor();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("coffee:session-invalidated")),
  );
  await page.getByText("operator-2").waitFor();
  assert.equal(new URL(page.url()).pathname, "/app/customers");
  await page.getByText("Восстановление прежней сессии недоступно").waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .count(),
    0,
  );
  assert.equal(telemetry.draftRequests.length, 1);
  await page.close();
}

async function replayFreshSessionBlocksActorConfusion(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, { abortFirstDraft: true });
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText("Исход команды неизвестен").waitFor();
  telemetry.switchActor();
  await page
    .getByRole("button", { name: "Проверить результат команды" })
    .click();
  await page.getByText("operator-2").waitFor();
  assert.equal(new URL(page.url()).pathname, "/app/customers");
  assert.equal(
    telemetry.draftRequests.length,
    1,
    "replay lookup не должен уходить после server-side смены actor",
  );
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    0,
  );
  await page.close();
}

async function replayRejectsTerminalFromAnotherOperation(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, {
    abortFirstDraft: true,
    replayWrongTerminal: true,
  });
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText("Исход команды неизвестен").waitFor();
  await page
    .getByRole("button", { name: "Проверить результат команды" })
    .click();
  await page
    .getByText("Сохранённый ответ не соответствует команде создания заказа")
    .waitFor();
  assert.equal(telemetry.draftRequests.length, 2);
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    1,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .count(),
    1,
  );
  await page.close();
}

async function sameActorReauthPreservesExplicitRecovery(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, { abortFirstDraft: true });
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText("Исход команды неизвестен").waitFor();
  telemetry.setSessionAvailable(false);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("coffee:session-invalidated")),
  );
  await page.getByText("Требуется вход").waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    1,
  );
  telemetry.setSessionAvailable(true);
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Проверить результат команды" })
    .waitFor();
  assert.equal(
    telemetry.draftRequests.length,
    1,
    "reauth не должен автоматически повторять команду или lookup",
  );
  await page
    .getByRole("button", { name: "Проверить результат команды" })
    .click();
  await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  assert.equal(telemetry.draftRequests.length, 2);
  assert.equal(
    telemetry.draftRequests[0]?.key,
    telemetry.draftRequests[1]?.key,
  );
  assert.equal(telemetry.draftRequests[1]?.replayOnly, true);
  await page.close();
}

async function missingCsrfBlocksMutation(
  context: BrowserContext,
): Promise<void> {
  const browser = context.browser();
  assert.ok(browser, "Playwright browser is unavailable");
  const isolated = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await isolated.clearCookies();
  const page = await isolated.newPage();
  await captureBrowserTelemetry(page);
  const telemetry = await installCommonMocks(page);
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  assert.equal(
    (await page.evaluate(() => document.cookie)).includes(
      "__Host-coffee-csrf=",
    ),
    false,
  );
  await page.getByRole("button", { name: "Создать черновик" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "CSRF-токен сессии отсутствует" });
  await alert.waitFor();
  assert.match(
    (await alert.textContent()) ?? "",
    /CSRF-токен сессии отсутствует/u,
  );
  assert.equal(telemetry.draftRequests.length, 0);
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    0,
  );
  assert.equal(await page.getByText("Исход команды неизвестен").count(), 0);
  assert.equal(
    (await browserTelemetry(page)).some(
      (event) =>
        event.name === "ui.command.result" && event.result === "blocked:csrf",
    ),
    true,
  );
  await isolated.close();
}

async function freshSessionBlocksActorConfusion(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page);
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  telemetry.switchActor();
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText("operator-2").waitFor();
  assert.equal(new URL(page.url()).pathname, "/app/customers");
  assert.equal(
    telemetry.draftRequests.length,
    0,
    "смена server session перед командой не должна отправлять POST",
  );
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    0,
  );
  await page.close();
}

async function csrfChangeDuringIntentPreparationBlocksMutation(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const scope = window as Window & { __coffeeCsrfInvalidated?: boolean };
    window.addEventListener(
      "coffee:session-invalidated",
      () => {
        scope.__coffeeCsrfInvalidated = true;
      },
      { once: true },
    );
    const original = Storage.prototype.setItem.bind(sessionStorage);
    let switched = false;
    Storage.prototype.setItem = function setItem(
      key: string,
      value: string,
    ): void {
      original(key, value);
      if (!switched && key.startsWith("coffee-platform:intent:v1:")) {
        switched = true;
        document.cookie =
          "__Host-coffee-csrf=switched-csrf-token; Path=/; Secure; SameSite=Strict";
      }
    };
  });
  const telemetry = await installCommonMocks(page);
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.waitForFunction(() => {
    const scope = window as Window & { __coffeeCsrfInvalidated?: boolean };
    return (
      scope.__coffeeCsrfInvalidated === true &&
      Object.keys(sessionStorage).every(
        (key) => !key.startsWith("coffee-platform:intent:v1:"),
      )
    );
  });
  assert.equal(telemetry.draftRequests.length, 0);
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    0,
  );
  await page.close();
  await context.addCookies([
    {
      domain: "localhost",
      name: "__Host-coffee-csrf",
      path: "/",
      secure: true,
      value: "test-csrf-token",
    },
  ]);
}

async function logoutDuringFingerprintDoesNotCreateIntent(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const scope = window as Window & {
      __coffeeDigestWaiting?: boolean;
      __coffeeReleaseDigest?: () => void;
    };
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scope.__coffeeReleaseDigest = () => release();
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
        scope.__coffeeDigestWaiting = true;
        await gate;
        return originalDigest(...args);
      },
    });
  });
  const telemetry = await installCommonMocks(page);
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.waitForFunction(
    () =>
      (window as Window & { __coffeeDigestWaiting?: boolean })
        .__coffeeDigestWaiting === true,
  );
  await page.getByRole("button", { name: "Выйти" }).click();
  await page
    .getByRole("dialog", { name: "Выйти из операторской платформы?" })
    .getByRole("button", { name: "Завершить сессию" })
    .click();
  await page.getByText("Требуется вход").waitFor();
  await page.evaluate(() =>
    (
      window as Window & { __coffeeReleaseDigest?: () => void }
    ).__coffeeReleaseDigest?.(),
  );
  await page.waitForTimeout(50);
  assert.equal(telemetry.draftRequests.length, 0);
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    0,
  );
  await page.close();
}

async function mismatchedProblemStatusRetainsIntent(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, {
    draftStatusMismatch: true,
  });
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText(/HTTP status 500 не совпадает/u).waitFor();
  await page.getByText("Исход команды неизвестен").waitFor();
  assert.equal(telemetry.draftRequests.length, 1);
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText(/уже есть неподтверждённый результат/u).waitFor();
  assert.equal(
    telemetry.draftRequests.length,
    1,
    "несогласованный Problem Details не должен разблокировать новый эффект",
  );
  await page.close();
}

async function reconciliationAcceptanceCannotBeResubmitted(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, {
    initialItem: true,
    reconciliationRefreshFails: true,
  });
  await page.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Подтвердить заказ" }).click();
  await page
    .getByRole("dialog", { name: "Подтвердить заказ?" })
    .getByRole("button", { name: "Подтвердить", exact: true })
    .click();
  await page.getByRole("button", { name: "Запросить сверку AROMA" }).click();
  const dialog = page.getByRole("dialog", { name: "Запросить сверку AROMA?" });
  await dialog
    .getByRole("textbox", { name: "Причина" })
    .fill("Проверка после подтверждения");
  await dialog.getByRole("button", { name: "Отправить запрос" }).click();
  await dialog.waitFor({ state: "hidden" });
  try {
    await page
      .getByText("Не удалось проверить актуальность карточки")
      .waitFor({ timeout: 10_000 });
  } catch {
    throw new Error(
      `Не показано предупреждение после принятой сверки и failed GET: ${(await page.locator("body").textContent()) ?? ""}`,
    );
  }
  assert.equal(
    await page.getByRole("heading", { name: "Иван Петров" }).count(),
    1,
    "503 refetch should keep the cached Card visible",
  );
  assert.deepEqual(telemetry.reconciliationReasons, [
    "Проверка после подтверждения",
  ]);
  assert.equal(
    await page.getByRole("button", { name: "Запросить сверку AROMA" }).count(),
    0,
  );
  await page.close();
}

async function reconciliationUnlocksAfterNewOwnerProjection(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, {
    allowUnknownOutcomeReconciliation: true,
    aromaScenario: "UnknownOutcome",
  });
  await page.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  const trigger = page.getByRole("button", { name: "Запросить сверку AROMA" });
  await trigger.waitFor();
  assert.equal(await trigger.isDisabled(), false);

  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "Запросить сверку AROMA?" });
  await dialog
    .getByRole("textbox", { name: "Причина" })
    .fill("Первая явная сверка");
  const sameSnapshotRefresh = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/client-v1/orders/${orderRef}`) &&
      response.request().method() === "GET",
  );
  await dialog.getByRole("button", { name: "Отправить запрос" }).click();
  const sameSnapshotResponse = await sameSnapshotRefresh;
  const sameSnapshotCard = (await sameSnapshotResponse.json()) as {
    projectionVersion: string;
  };
  assert.equal(sameSnapshotCard.projectionVersion, "5");
  await dialog.waitFor({ state: "hidden" });
  await expect.poll(() => trigger.isDisabled()).toBe(true);
  await page.getByText("Результат неизвестен", { exact: true }).waitFor();
  assert.deepEqual(telemetry.reconciliationReasons, ["Первая явная сверка"]);
  assert.deepEqual(telemetry.reconciliationExpectedVersions, ["5"]);

  telemetry.advanceReconciliationProjection();
  const newerSnapshot = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/client-v1/orders/${orderRef}`) &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Проверить состояние" }).click();
  const newerSnapshotResponse = await newerSnapshot;
  const newerCard = (await newerSnapshotResponse.json()) as {
    allowedActions: string[];
    aroma: { state: string };
    projectionVersion: string;
    version: string;
  };
  assert.equal(newerCard.projectionVersion, "6");
  assert.equal(
    newerCard.version,
    "5",
    "AROMA projection advancement must not change the Order business version",
  );
  assert.equal(newerCard.aroma.state, "OutOfSync");
  assert.ok(newerCard.allowedActions.includes("request-aroma-reconciliation"));
  await page.getByText("Есть расхождение", { exact: true }).waitFor();
  await expect.poll(() => trigger.isDisabled()).toBe(false);
  assert.deepEqual(
    telemetry.reconciliationReasons,
    ["Первая явная сверка"],
    "a fresh owner GET must not automatically submit another reconciliation",
  );

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "Запросить сверку AROMA?" });
  await dialog
    .getByRole("textbox", { name: "Причина" })
    .fill("Вторая явная сверка");
  const repeatedSnapshotRefresh = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/client-v1/orders/${orderRef}`) &&
      response.request().method() === "GET",
  );
  await dialog.getByRole("button", { name: "Отправить запрос" }).click();
  await repeatedSnapshotRefresh;
  await dialog.waitFor({ state: "hidden" });
  await expect.poll(() => telemetry.reconciliationReasons.length).toBe(2);
  await expect.poll(() => trigger.isDisabled()).toBe(true);
  assert.deepEqual(telemetry.reconciliationReasons, [
    "Первая явная сверка",
    "Вторая явная сверка",
  ]);
  assert.deepEqual(
    telemetry.reconciliationExpectedVersions,
    ["5", "5"],
    "projection-only advancement must not change the command business version",
  );
  assert.ok(telemetry.reconciliationKeys[0]);
  assert.notEqual(
    telemetry.reconciliationKeys[1],
    telemetry.reconciliationKeys[0],
    "a new explicit reconciliation intent must use a new idempotency key",
  );
  await page.close();
}

async function reconciliationStaysBlockedDuringOwnerRefresh(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, {
    holdReconciliationRefresh: true,
    initialItem: true,
  });
  await page.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Подтвердить заказ" }).click();
  await page
    .getByRole("dialog", { name: "Подтвердить заказ?" })
    .getByRole("button", { name: "Подтвердить", exact: true })
    .click();
  await page.getByRole("button", { name: "Запросить сверку AROMA" }).click();
  const dialog = page.getByRole("dialog", { name: "Запросить сверку AROMA?" });
  await dialog
    .getByRole("textbox", { name: "Причина" })
    .fill("Проверка блокировки повтора");
  await dialog.getByRole("button", { name: "Отправить запрос" }).click();
  await dialog.waitFor({ state: "hidden" });
  const trigger = page.getByRole("button", { name: "Запросить сверку AROMA" });
  await trigger.waitFor();
  assert.equal(await trigger.isDisabled(), true);
  assert.deepEqual(telemetry.reconciliationReasons, [
    "Проверка блокировки повтора",
  ]);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(
      geometry.scrollWidth <= geometry.clientWidth + 1,
      `${width}px reconciliation pending overflow: ${JSON.stringify(geometry)}`,
    );
    assert.equal(await trigger.isDisabled(), true);
    await capture(page, `reconciliation-pending-${width}.png`);
  }
  const violations = await new AxeBuilder({ page }).analyze();
  assert.equal(
    violations.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ).length,
    0,
  );
  telemetry.releaseReconciliationRefresh();
  await page.waitForTimeout(50);
  await page.close();
}

async function replayDoesNotPublishHistoricalCard(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await installCommonMocks(page, {
    abortFirstDraft: true,
    orderUnavailable: true,
  });
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText("Исход команды неизвестен").waitFor();
  await page
    .getByRole("button", { name: "Проверить результат команды" })
    .click();
  try {
    await page
      .getByText("Результат найден, но текущая карточка недоступна")
      .waitFor({ timeout: 10_000 });
  } catch {
    throw new Error(
      `Не показана ошибка authoritative GET после replay: ${(await page.locator("body").textContent()) ?? ""}`,
    );
  }
  assert.equal(
    await page.getByRole("heading", { name: "Иван Петров" }).count(),
    0,
    "historical replay не должен становиться current Order Card",
  );
  await page.close();
}

async function replayVerificationUpdatesExactOrderQuery(
  context: BrowserContext,
): Promise<void> {
  for (const status of [403, 404, 503] as const) {
    const page = await context.newPage();
    const telemetry = await installCommonMocks(page, {
      abortFirstPut: true,
      initialItem: true,
      orderFailureOnRefetch: status,
    });
    const orderCardStatuses: number[] = [];
    page.on("response", (response) => {
      if (
        new URL(response.url()).pathname ===
          `/api/client-v1/orders/${orderRef}` &&
        response.request().method() === "GET"
      ) {
        orderCardStatuses.push(response.status());
      }
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await page.getByRole("heading", { name: "Капучино" }).waitFor();
    const initialOrderCardReads = orderCardStatuses.length;
    await page.getByRole("textbox", { name: "Количество Капучино" }).fill("3");
    await page.getByRole("button", { name: "Обновить", exact: true }).click();
    const pendingPut = async () =>
      page.evaluate(() =>
        Object.keys(sessionStorage)
          .filter((key) => key.startsWith("coffee-platform:intent:v1:"))
          .map(
            (key) =>
              JSON.parse(sessionStorage.getItem(key) ?? "null") as {
                kind?: string;
                state?: string;
              },
          )
          .find((intent) => intent?.kind === "put-item"),
      );
    await expect
      .poll(async () => (await pendingPut())?.state)
      .toBe("ambiguous");
    await expect.poll(() => telemetry.putRequests.length).toBe(1);
    assert.equal((await pendingPut())?.kind, "put-item");
    telemetry.armOrderFailure();
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .click();
    await page
      .getByText("Результат найден, но текущая карточка недоступна")
      .waitFor();
    const expectedStatuses = status === 503 ? [503, 503] : [status];
    await expect
      .poll(() => orderCardStatuses.slice(initialOrderCardReads))
      .toEqual(expectedStatuses);
    assert.equal(
      new URL(page.url()).pathname,
      `/app/orders/${orderRef}`,
      "verification stays on the same Order Card route",
    );
    assert.deepEqual(telemetry.putReplayOnly, [false, true]);
    assert.equal(
      telemetry.putRequests.length,
      2,
      "verification must not repeat the business mutation",
    );
    assert.equal(
      telemetry.putRequests[1],
      "",
      "replay lookup must be bodyless",
    );
    assert.equal(
      telemetry.putIntentKeys[0],
      telemetry.putIntentKeys[1],
      "replay must reuse the accepted command key",
    );

    if (status === 503) {
      await page
        .getByText("Не удалось проверить актуальность карточки", {
          exact: true,
        })
        .waitFor();
      await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
      await page.getByRole("heading", { name: "Капучино" }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Подтвердить заказ" }).count(),
        1,
      );
    } else {
      await expect(
        page.getByRole("heading", { name: "Иван Петров" }),
      ).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Капучино" })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("button", { name: "Подтвердить заказ" }),
      ).toHaveCount(0);
    }
    await page.close();
  }
}

async function lateMutationCannotRestoreAfterFatalOwnerRead(
  context: BrowserContext,
): Promise<void> {
  for (const fatalStatus of [403, 404] as const) {
    const page = await context.newPage();
    const telemetry = await installCommonMocks(page, {
      holdFirstPut: true,
      initialItem: true,
      orderFailureSequence: [fatalStatus, 503, "divergent-200"],
    });
    const orderCardStatuses: number[] = [];
    page.on("response", (response) => {
      if (
        new URL(response.url()).pathname ===
          `/api/client-v1/orders/${orderRef}` &&
        response.request().method() === "GET"
      ) {
        orderCardStatuses.push(response.status());
      }
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    const quantity = page.getByRole("textbox", { name: "Количество Капучино" });
    await quantity.fill("3");
    await page.getByRole("button", { name: "Обновить", exact: true }).click();
    await expect.poll(() => telemetry.putRequests.length).toBe(1);
    telemetry.armOrderFailure();
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .click();
    await page
      .getByText(
        "Результат команды найден, но текущее состояние заказа проверить не удалось",
      )
      .waitFor();
    if (fatalStatus === 403)
      await page
        .locator("#route-content")
        .getByText("Недостаточно прав")
        .waitFor();
    else await page.getByRole("heading", { name: "Заказ не найден" }).waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "Иван Петров" }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("heading", { name: "Капучино" }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "Подтвердить заказ" }).count(),
      0,
    );
    assert.deepEqual(telemetry.putReplayOnly, [false, true]);

    const latePutResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/client-v1/orders/${orderRef}/items/itm_01ARZ3NDEKTSV4RRFFQ69G5FAV` &&
        response.request().method() === "PUT" &&
        response.request().headers()["idempotency-replay-only"] !== "true",
    );
    telemetry.releaseFirstPut();
    assert.equal((await latePutResponse).status(), 200);
    await page.waitForTimeout(50);
    assert.equal(
      await page.getByRole("heading", { name: "Иван Петров" }).count(),
      0,
      "late successful PUT cannot clear the fatal owner-read error",
    );
    assert.equal(
      await page.getByRole("heading", { name: "Капучино" }).count(),
      0,
    );
    assert.equal(
      telemetry.putRequests.length,
      2,
      "the recovery lookup does not repeat the business mutation",
    );

    // Keep one SPA document and QueryClient across refetch failures and explicit recovery.
    await page.evaluate((href) => {
      window.history.pushState(window.history.state, "", href);
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: window.history.state }),
      );
    }, "/app/customers");
    await page.getByRole("heading", { name: "Клиенты" }).waitFor();
    const unavailableRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/client-v1/orders/${orderRef}` &&
        response.request().method() === "GET" &&
        response.status() === 503,
    );
    await page.goBack({ waitUntil: "networkidle" });
    await unavailableRead;
    if (fatalStatus === 403)
      await page
        .locator("#route-content")
        .getByText("Недостаточно прав")
        .waitFor();
    else await page.getByRole("heading", { name: "Заказ не найден" }).waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "Иван Петров" }).count(),
      0,
      "a later 503 does not release the fatal barrier",
    );
    assert.equal(
      await page.getByRole("button", { name: "Подтвердить заказ" }).count(),
      0,
    );

    await page.evaluate((href) => {
      window.history.pushState(window.history.state, "", href);
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: window.history.state }),
      );
    }, "/app/customers");
    await page.getByRole("heading", { name: "Клиенты" }).waitFor();
    const divergentRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/client-v1/orders/${orderRef}` &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await page.goBack({ waitUntil: "networkidle" });
    const divergentCard = (await (await divergentRead).json()) as {
      projectionVersion: string;
      status: string;
    };
    assert.equal(divergentCard.projectionVersion, "2");
    assert.equal(divergentCard.status, "Confirmed");
    if (fatalStatus === 403)
      await page
        .locator("#route-content")
        .getByText("Недостаточно прав")
        .waitFor();
    else await page.getByRole("heading", { name: "Заказ не найден" }).waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "Иван Петров" }).count(),
      0,
      "a divergent equal-projection 200 does not replace the fatal read error",
    );
    assert.equal(
      await page.getByRole("heading", { name: "Капучино" }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "Подтвердить заказ" }).count(),
      0,
    );

    await page.evaluate((href) => {
      window.history.pushState(window.history.state, "", href);
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: window.history.state }),
      );
    }, "/app/customers");
    await page.getByRole("heading", { name: "Клиенты" }).waitFor();
    const successfulRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/client-v1/orders/${orderRef}` &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await page.goBack({ waitUntil: "networkidle" });
    const freshCard = (await (await successfulRead).json()) as {
      projectionVersion: string;
      status: string;
    };
    assert.equal(freshCard.projectionVersion, "3");
    assert.equal(freshCard.status, "Draft");
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await page.getByRole("heading", { name: "Капучино" }).waitFor();
    assert.deepEqual(telemetry.putReplayOnly, [false, true]);
    assert.deepEqual(orderCardStatuses.slice(-4), [fatalStatus, 503, 200, 200]);
    await page.close();
  }
}

async function explicitLogoutClearsRecovery(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, { abortFirstDraft: true });
  await page.goto(`${origin}/app/orders/new?customerRef=${customerRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByText("Исход команды неизвестен").waitFor();
  await page.getByRole("button", { name: "Выйти" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Выйти из операторской платформы?",
  });
  await dialog.getByText("Есть незавершённые команды").waitFor();
  await dialog.getByRole("button", { name: "Завершить сессию" }).click();
  await page.getByText("Требуется вход").waitFor();
  assert.deepEqual(telemetry.logoutRequests, ["POST"]);
  assert.equal(telemetry.correlationFailures.length, 0);
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    0,
  );
  assert.equal(
    await page.getByRole("heading", { name: "Новый заказ" }).count(),
    0,
  );
  await page.close();
}

async function expiredSessionHidesPrivateRoutes(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await installCommonMocks(page, { expiredSession: true });
  await page.goto(`${origin}/app/customers`, { waitUntil: "networkidle" });
  await page.getByText("Требуется вход").waitFor();
  assert.equal(await page.getByRole("heading", { name: "Клиенты" }).count(), 0);
  await page.close();
}

async function actorChangeClearsCustomerFormAfterPeriodicSessionCheck(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await page.clock.install();
  const telemetry = await installCommonMocks(page);
  await page.goto(`${origin}/app/customers`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Новый клиент" }).click();
  const customerDialog = page.getByRole("dialog", { name: "Новый клиент" });
  await customerDialog
    .getByRole("textbox", { name: "Имя", exact: true })
    .fill("Иван Петров");
  await customerDialog
    .getByRole("textbox", { name: "Телефон", exact: true })
    .fill("+79999994567");
  await customerDialog
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("ivan@example.test");
  telemetry.switchActor();
  const switchedSession = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/auth/session",
  );
  await page.clock.fastForward(31_000);
  await switchedSession;
  await page.getByText("operator-2").waitFor();
  await customerDialog.waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("textbox", { name: "Имя", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Телефон", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Email", exact: true }).count(),
    0,
  );
  await page.close();
}

async function unavailableSessionHidesPrivateRoutes(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await installCommonMocks(page, { sessionUnavailable: true });
  await page.goto(`${origin}/app/customers`, { waitUntil: "networkidle" });
  await page.getByText("Не удалось проверить сессию").waitFor();
  assert.equal(await page.getByText("Session service unavailable").count(), 0);
  assert.equal(await page.getByText("AUTHORIZATION_UNAVAILABLE").count(), 0);
  assert.equal(await page.getByText(/Correlation ID/iu).count(), 0);
  const retry = page.getByRole("button", { name: "Повторить проверку" });
  await retry.waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Войти через защищённый контур" })
      .count(),
    0,
  );
  assert.equal(await page.getByRole("heading", { name: "Клиенты" }).count(), 0);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const size = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      size.scroll <= size.client + 1,
      `${width}px auth-unavailable overflow: ${JSON.stringify(size)}`,
    );
    const retryBox = await retry.boundingBox();
    assert.ok(
      retryBox && retryBox.height >= 44,
      `${width}px auth retry target must be at least 44px high`,
    );
    await capture(page, `auth-unavailable-${width}.png`);
  }
  const violations = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(
    violations.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    ),
    [],
  );
  await retry.click();
  await page.getByText("Не удалось проверить сессию").waitFor();
  await page.close();
}

async function forbiddenResourceKeepsSessionAndShowsRightsError(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await installCommonMocks(page, { forbiddenCustomers: true });
  await page.goto(`${origin}/app/customers?q=иван`, {
    waitUntil: "networkidle",
  });
  await page.getByText("Недостаточно прав").waitFor();
  await page.getByText("СЕССИЯ АКТИВНА").waitFor();
  assert.equal(await page.getByText("Actor cannot read customers").count(), 0);
  assert.equal(await page.getByText("AUTHORIZATION_FORBIDDEN").count(), 0);
  assert.equal(await page.getByText(/Correlation ID/iu).count(), 0);
  assert.equal(await page.getByText("Требуется вход").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Обновить данные" }).count(),
    0,
  );
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const size = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      size.scroll <= size.client + 1,
      `${width}px forbidden overflow: ${JSON.stringify(size)}`,
    );
    await capture(page, `customers-forbidden-${width}.png`);
  }
  const violations = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(
    violations.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    ),
    [],
  );
  await page.close();
}

async function cachedCustomersAreHiddenAfterForbiddenRefetch(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await page.clock.install();
  const telemetry = await installCommonMocks(page, {
    customerNextCursor: true,
    customerRefetchFailureSequence: { query: "иван", statuses: [403, 503] },
  });
  const customerStatuses: number[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.pathname === "/api/client-v1/customers" &&
      url.searchParams.get("query") === "иван"
    )
      customerStatuses.push(response.status());
  });
  await page.goto(`${origin}/app/customers?q=иван`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  await page.getByText("+799••••4567").waitFor();
  await page.getByRole("button", { name: "Выбрать" }).waitFor();
  await page.getByRole("button", { name: "Следующая страница" }).waitFor();
  const baselineReads = customerStatuses.length;

  const pushOrderRoute = async (): Promise<void> => {
    await page.evaluate((href) => {
      window.history.pushState(window.history.state, "", href);
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: window.history.state }),
      );
    }, `/app/orders/${orderRef}`);
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  };
  const backToCustomerWithStatus = async (
    status: 200 | 403 | 503,
  ): Promise<void> => {
    const response = page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return (
        url.pathname === "/api/client-v1/customers" &&
        url.searchParams.get("query") === "иван" &&
        candidate.status() === status
      );
    });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await response;
  };
  const assertCustomerSearchHidden = async (): Promise<void> => {
    assert.equal(
      await page.getByRole("heading", { name: "Иван Петров" }).count(),
      0,
      `cached customer remained visible; GET statuses=${JSON.stringify(customerStatuses.slice(baselineReads))}`,
    );
    assert.equal(await page.getByText("+799••••4567").count(), 0);
    assert.equal(await page.getByText(customerRef).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Выбрать" }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "Следующая страница" }).count(),
      0,
    );
  };

  telemetry.armCustomerFailure();
  await pushOrderRoute();
  await page.clock.fastForward(31_000);
  await backToCustomerWithStatus(403);
  await page.getByText("Недостаточно прав").waitFor();
  await assertCustomerSearchHidden();

  await pushOrderRoute();
  await backToCustomerWithStatus(503);
  await page.clock.fastForward(500);
  await page.waitForTimeout(50);
  await assertCustomerSearchHidden();
  telemetry.clearSearchFailures();

  await pushOrderRoute();
  await backToCustomerWithStatus(200);
  await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  await page.getByText("+799••••4567").waitFor();
  await page.getByText(customerRef).waitFor();
  await page.getByRole("button", { name: "Выбрать" }).waitFor();
  await page.getByRole("button", { name: "Следующая страница" }).waitFor();

  await page.clock.fastForward(31_000);
  telemetry.armCustomerFailure();
  await pushOrderRoute();
  const firstUnavailable = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/client-v1/customers" &&
      new URL(response.url()).searchParams.get("query") === "иван" &&
      response.status() === 503,
  );
  await page.goBack({ waitUntil: "domcontentloaded" });
  await firstUnavailable;
  const retryUnavailable = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/client-v1/customers" &&
      new URL(response.url()).searchParams.get("query") === "иван" &&
      response.status() === 503,
  );
  await page.clock.fastForward(500);
  await retryUnavailable;
  await page.getByText("Сервис временно недоступен").waitFor();
  await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  await page.getByText("+799••••4567").waitFor();
  await page.getByRole("button", { name: "Выбрать" }).waitFor();
  await page.getByRole("button", { name: "Следующая страница" }).waitFor();
  assert.deepEqual(
    customerStatuses.slice(baselineReads),
    [403, 503, 200, 503, 503],
  );
  assert.equal(
    await page.getByRole("button", { name: "Обновить данные" }).count(),
    1,
    "ordinary 503 retains its explicit retry",
  );
  await page.close();
}

async function cachedCatalogRefetchKeepsAccessAndAvailabilitySeparate(
  context: BrowserContext,
): Promise<void> {
  for (const status of [403, 503] as const) {
    const page = await context.newPage();
    await page.clock.install();
    const telemetry = await installCommonMocks(page, {
      catalogNextCursor: true,
      ...(status === 403
        ? {
            catalogRefetchFailureSequence: {
              query: "капучино",
              statuses: [403, 503],
            },
          }
        : { catalogRefetchFailure: { query: "капучино", status } }),
    });
    await page.goto(`${origin}/app/catalog?orderRef=${orderRef}&q=капучино`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("heading", { name: "Капучино" }).waitFor();
    await page
      .getByRole("textbox", { name: "Количество для Капучино" })
      .waitFor();
    await page.getByRole("combobox", { name: "Помол для Капучино" }).waitFor();
    await page.getByRole("button", { name: "Добавить" }).waitFor();
    await page.getByRole("button", { name: "Следующая страница" }).waitFor();

    // SPA-переход сохраняет один QueryClient: обычный UI Link перезагружает документ.
    await page.evaluate((href) => {
      window.history.pushState(window.history.state, "", href);
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: window.history.state }),
      );
    }, `/app/orders/${orderRef}`);
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await page.getByRole("link", { name: "Открыть каталог" }).waitFor();
    await page.getByText("operator-1").waitFor();
    telemetry.armCatalogFailure();
    await page.clock.fastForward(31_000);

    const catalogStatuses: number[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (
        url.pathname === "/api/client-v1/catalog/products" &&
        url.searchParams.get("query") === "капучино"
      )
        catalogStatuses.push(response.status());
    });
    const firstFailure = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/client-v1/catalog/products" &&
        new URL(response.url()).searchParams.get("query") === "капучино" &&
        response.status() === status,
    );
    const catalogRefetch = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/api/client-v1/catalog/products" &&
        url.searchParams.get("query") === "капучино"
      );
    });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await catalogRefetch;
    await page.getByRole("heading", { name: "Капучино" }).waitFor();
    await page
      .getByRole("textbox", { name: "Количество для Капучино" })
      .waitFor();
    await page.getByRole("combobox", { name: "Помол для Капучино" }).waitFor();
    await page.getByRole("button", { name: "Добавить" }).waitFor();
    await page.getByRole("button", { name: "Следующая страница" }).waitFor();
    assert.deepEqual(
      catalogStatuses,
      [],
      "the armed refetch stays pending while cached product fields are verified",
    );
    telemetry.releaseCatalogRefetch();
    await firstFailure;
    if (status === 503) {
      const retryFailure = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            "/api/client-v1/catalog/products" &&
          new URL(response.url()).searchParams.get("query") === "капучино" &&
          response.status() === 503,
      );
      await page.clock.fastForward(500);
      await retryFailure;
    }
    await page
      .getByText(
        status === 403 ? "Недостаточно прав" : "Сервис временно недоступен",
      )
      .waitFor();
    await page.getByText("operator-1").waitFor();
    assert.deepEqual(catalogStatuses, status === 403 ? [403] : [503, 503]);
    assert.equal(
      await page.getByRole("textbox", { name: "Название товара" }).inputValue(),
      "капучино",
    );
    if (status === 403) {
      assert.equal(
        await page.getByRole("heading", { name: "Капучино" }).count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Количество для Капучино" })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("combobox", { name: "Помол для Капучино" })
          .count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Добавить" }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Следующая страница" }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Обновить данные" }).count(),
        0,
      );
      assert.deepEqual(catalogStatuses, [403]);

      await page.evaluate((href) => {
        window.history.pushState(window.history.state, "", href);
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: window.history.state }),
        );
      }, `/app/orders/${orderRef}`);
      await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
      const unavailableAfterForbidden = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            "/api/client-v1/catalog/products" &&
          new URL(response.url()).searchParams.get("query") === "капучино" &&
          response.status() === 503,
      );
      await page.goBack({ waitUntil: "domcontentloaded" });
      await unavailableAfterForbidden;
      await page.clock.fastForward(500);
      await page.waitForTimeout(50);
      assert.equal(
        await page.getByRole("heading", { name: "Капучино" }).count(),
        0,
        `403 remains sticky after a later 503; GET statuses=${JSON.stringify(catalogStatuses)}`,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Количество для Капучино" })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("combobox", { name: "Помол для Капучино" })
          .count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Добавить" }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Следующая страница" }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Обновить данные" }).count(),
        0,
      );
      telemetry.clearSearchFailures();

      await page.evaluate((href) => {
        window.history.pushState(window.history.state, "", href);
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: window.history.state }),
        );
      }, `/app/orders/${orderRef}`);
      await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
      const successfulCatalogRead = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            "/api/client-v1/catalog/products" &&
          new URL(response.url()).searchParams.get("query") === "капучино" &&
          response.status() === 200,
      );
      await page.goBack({ waitUntil: "domcontentloaded" });
      await successfulCatalogRead;
      await page.getByRole("heading", { name: "Капучино" }).waitFor();
      await page
        .getByRole("textbox", { name: "Количество для Капучино" })
        .waitFor();
      await page
        .getByRole("combobox", { name: "Помол для Капучино" })
        .waitFor();
      await page.getByRole("button", { name: "Добавить" }).waitFor();
      await page.getByRole("button", { name: "Следующая страница" }).waitFor();
      assert.deepEqual(catalogStatuses, [403, 503, 200]);
    } else {
      await page.getByRole("heading", { name: "Капучино" }).waitFor();
      assert.equal(
        await page
          .getByRole("textbox", { name: "Количество для Капучино" })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("combobox", { name: "Помол для Капучино" })
          .count(),
        1,
      );
      assert.equal(
        await page.getByRole("button", { name: "Добавить" }).count(),
        1,
      );
      assert.equal(
        await page.getByRole("button", { name: "Следующая страница" }).count(),
        1,
      );
    }
    await page.close();
  }
}

async function unavailableDependenciesPreserveOperatorContext(
  context: BrowserContext,
): Promise<void> {
  const customersPage = await context.newPage();
  await installCommonMocks(customersPage, { customersUnavailable: true });
  await customersPage.goto(`${origin}/app/customers?q=иван`, {
    waitUntil: "networkidle",
  });
  await customersPage.getByText("Сервис временно недоступен").waitFor();
  assert.equal(
    await customersPage
      .getByRole("textbox", { name: "Поиск клиента" })
      .inputValue(),
    "иван",
  );
  await customersPage
    .getByRole("button", { name: "Обновить данные" })
    .waitFor();
  await customersPage.close();

  const catalogPage = await context.newPage();
  const catalog = await installCommonMocks(catalogPage, {
    catalogRefetchFailure: { query: "капучино", status: 503 },
  });
  const catalogReads: Array<{
    query: string | null;
    availability: string | null;
    status: number;
  }> = [];
  catalogPage.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.pathname === "/api/client-v1/catalog/products" &&
      response.request().method() === "GET"
    ) {
      catalogReads.push({
        query: url.searchParams.get("query"),
        availability: url.searchParams.get("availability"),
        status: response.status(),
      });
    }
  });
  catalog.armCatalogFailure();
  catalog.releaseCatalogRefetch();
  await catalogPage.goto(
    `${origin}/app/catalog?orderRef=${orderRef}&q=капучино`,
    { waitUntil: "networkidle" },
  );
  await catalogPage.getByText("Сервис временно недоступен").waitFor();
  assert.equal(
    await catalogPage
      .getByRole("textbox", { name: "Название товара" })
      .inputValue(),
    "капучино",
  );
  assert.equal(
    await catalogPage.getByRole("button", { name: "Обновить данные" }).count(),
    1,
  );
  assert.equal(
    await catalogPage.getByRole("heading", { name: "Капучино" }).count(),
    0,
  );
  assert.deepEqual(catalogReads, [
    { query: "капучино", availability: "Available", status: 503 },
    { query: "капучино", availability: "Available", status: 503 },
  ]);

  catalog.clearSearchFailures();
  const recoveredCatalog = catalogPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/client-v1/catalog/products" &&
      response.request().method() === "GET" &&
      url.searchParams.get("query") === "капучино" &&
      url.searchParams.get("availability") === "Available" &&
      response.status() === 200
    );
  });
  await catalogPage.getByRole("button", { name: "Обновить данные" }).click();
  await recoveredCatalog;
  await catalogPage.getByRole("heading", { name: "Капучино" }).waitFor();
  await catalogPage
    .getByRole("textbox", { name: "Количество для Капучино" })
    .waitFor();
  await catalogPage
    .getByRole("combobox", { name: "Помол для Капучино" })
    .waitFor();
  await catalogPage.getByRole("button", { name: "Добавить" }).waitFor();
  assert.deepEqual(catalogReads, [
    { query: "капучино", availability: "Available", status: 503 },
    { query: "капучино", availability: "Available", status: 503 },
    { query: "капучино", availability: "Available", status: 200 },
  ]);
  const recoveredUrl = new URL(catalogPage.url());
  assert.equal(recoveredUrl.pathname, "/app/catalog");
  assert.equal(recoveredUrl.searchParams.get("orderRef"), orderRef);
  assert.equal(recoveredUrl.searchParams.get("q"), "капучино");
  assert.equal(recoveredUrl.searchParams.has("availability"), false);
  assert.equal(catalog.quoteRequests.length, 0);
  assert.equal(catalog.putRequests.length, 0);
  await catalogPage.close();

  const pricingPage = await context.newPage();
  await installCommonMocks(pricingPage, { pricingUnavailable: true });
  await pricingPage.goto(
    `${origin}/app/catalog?orderRef=${orderRef}&q=капучино`,
    { waitUntil: "networkidle" },
  );
  const quantity = pricingPage.getByRole("textbox", {
    name: "Количество для Капучино",
  });
  await quantity.fill("2");
  await pricingPage.getByRole("button", { name: "Добавить" }).click();
  await pricingPage.getByText("Сервис временно недоступен").waitFor();
  assert.equal(await quantity.inputValue(), "2");
  await pricingPage.close();
}

async function aromaBlockedAndUnknownOutcomeUseOwnerActions(
  context: BrowserContext,
): Promise<void> {
  const unknownPage = await context.newPage();
  await installCommonMocks(unknownPage, { aromaScenario: "UnknownOutcome" });
  await unknownPage.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  await unknownPage.getByText("Результат неизвестен").waitFor();
  await unknownPage.getByText("Исход AROMA неизвестен").waitFor();
  await unknownPage
    .getByRole("button", { name: "Проверить состояние" })
    .waitFor();
  assert.equal(
    await unknownPage
      .getByRole("button", { name: "Запросить сверку AROMA" })
      .count(),
    0,
  );
  await unknownPage.close();

  const blockedPage = await context.newPage();
  await installCommonMocks(blockedPage, {
    aromaBlocker: "AROMA_QUANTITY_NOT_SUPPORTED",
    aromaScenario: "Blocked",
  });
  await blockedPage.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  await blockedPage.getByText("Заблокировано").waitFor();
  await blockedPage
    .getByText("Количество нельзя безопасно передать в AROMA")
    .waitFor();
  assert.equal(
    await blockedPage
      .getByRole("button", { name: "Запросить сверку AROMA" })
      .count(),
    0,
  );
  await blockedPage.close();
}

async function grindSelectionFlows(context: BrowserContext): Promise<void> {
  const selectedPage = await context.newPage();
  const selected = await installCommonMocks(selectedPage);
  await selectedPage.goto(
    `${origin}/app/catalog?orderRef=${orderRef}&q=капучино`,
    { waitUntil: "networkidle" },
  );
  await selectedPage
    .getByRole("combobox", { name: "Помол для Капучино" })
    .selectOption(grindHash);
  await selectedPage.getByRole("button", { name: "Добавить" }).click();
  await selectedPage.getByText("Товар добавлен").waitFor();
  assert.equal(
    JSON.parse(selected.quoteRequests[0] ?? "{}").lines[0].sourceGrindKeyHash,
    grindHash,
  );
  assert.equal(
    JSON.parse(selected.putRequests[0] ?? "{}").sourceGrindKeyHash,
    grindHash,
  );
  await selectedPage.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  await selectedPage.getByText("Помол: Мелкий помол").waitFor();
  await selectedPage.close();

  const unselectedPage = await context.newPage();
  const unselected = await installCommonMocks(unselectedPage);
  await unselectedPage.goto(
    `${origin}/app/catalog?orderRef=${orderRef}&q=капучино`,
    { waitUntil: "networkidle" },
  );
  assert.equal(
    await unselectedPage
      .getByRole("combobox", { name: "Помол для Капучино" })
      .inputValue(),
    "",
  );
  await unselectedPage.getByRole("button", { name: "Добавить" }).click();
  await unselectedPage.getByText("Товар добавлен").waitFor();
  assert.equal(
    "sourceGrindKeyHash" in
      JSON.parse(unselected.quoteRequests[0] ?? "{}").lines[0],
    false,
  );
  assert.equal(
    "sourceGrindKeyHash" in JSON.parse(unselected.putRequests[0] ?? "{}"),
    false,
  );
  await unselectedPage.close();

  const refreshedPage = await context.newPage();
  const refreshed = await installCommonMocks(refreshedPage, {
    grindSelectionRefresh: true,
  });
  await refreshedPage.goto(
    `${origin}/app/catalog?orderRef=${orderRef}&q=капучино`,
    { waitUntil: "networkidle" },
  );
  const grindSelect = refreshedPage.getByRole("combobox", {
    name: "Помол для Капучино",
  });
  await grindSelect.selectOption(grindHash);
  const searchFor = async (query: string): Promise<void> => {
    const response = refreshedPage.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return (
        url.pathname === "/api/client-v1/catalog/products" &&
        url.searchParams.get("query") === query
      );
    });
    await refreshedPage
      .getByRole("textbox", { name: "Название товара" })
      .fill(query);
    await refreshedPage.getByRole("button", { name: "Найти" }).click();
    await response;
  };
  await searchFor("кофе");
  const unavailableOption = refreshedPage.getByRole("option", {
    name: "Выбранный помол недоступен",
  });
  await unavailableOption.waitFor({ state: "attached" });
  assert.equal(await grindSelect.inputValue(), grindHash);
  assert.notEqual(await unavailableOption.getAttribute("disabled"), null);
  await grindSelect.selectOption("");
  await grindSelect.waitFor({ state: "detached" });
  assert.equal(
    await grindSelect.count(),
    0,
    "явное отсутствие выбора должно сбрасывать устаревший hash",
  );
  const clearedQuoteResponse = refreshedPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/client-v1/pricing/quotes") &&
      response.request().method() === "POST",
  );
  const clearedPutResponse = refreshedPage.waitForResponse(
    (response) =>
      /\/api\/client-v1\/orders\/ord_[^/]+\/items\/itm_[^/]+$/u.test(
        new URL(response.url()).pathname,
      ) && response.request().method() === "PUT",
  );
  await refreshedPage.getByRole("button", { name: "Добавить" }).click();
  await Promise.all([clearedQuoteResponse, clearedPutResponse]);
  assert.equal(
    "sourceGrindKeyHash" in
      JSON.parse(refreshed.quoteRequests[0] ?? "{}").lines[0],
    false,
  );
  assert.equal(
    "sourceGrindKeyHash" in JSON.parse(refreshed.putRequests[0] ?? "{}"),
    false,
  );
  await searchFor("кофе b");
  await grindSelect.selectOption(replacementGrindHash);
  const replacementQuoteResponse = refreshedPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/client-v1/pricing/quotes") &&
      response.request().method() === "POST",
  );
  const replacementPutResponse = refreshedPage.waitForResponse(
    (response) =>
      /\/api\/client-v1\/orders\/ord_[^/]+\/items\/itm_[^/]+$/u.test(
        new URL(response.url()).pathname,
      ) && response.request().method() === "PUT",
  );
  await refreshedPage.getByRole("button", { name: "Добавить" }).click();
  await Promise.all([replacementQuoteResponse, replacementPutResponse]);
  assert.equal(
    JSON.parse(refreshed.quoteRequests[1] ?? "{}").lines[0].sourceGrindKeyHash,
    replacementGrindHash,
  );
  assert.equal(
    JSON.parse(refreshed.putRequests[1] ?? "{}").sourceGrindKeyHash,
    replacementGrindHash,
  );
  await refreshedPage.close();

  const unavailablePage = await context.newPage();
  const unavailable = await installCommonMocks(unavailablePage, {
    staleGrind: true,
  });
  await unavailablePage.goto(
    `${origin}/app/catalog?orderRef=${orderRef}&q=капучино`,
    { waitUntil: "networkidle" },
  );
  await unavailablePage
    .getByRole("combobox", { name: "Помол для Капучино" })
    .selectOption(grindHash);
  await unavailablePage.getByRole("button", { name: "Добавить" }).click();
  await unavailablePage
    .getByText("Помол недоступен", { exact: true })
    .waitFor();
  assert.equal(unavailable.quoteRequests.length, 1);
  assert.equal(
    JSON.parse(unavailable.quoteRequests[0] ?? "{}").lines[0]
      .sourceGrindKeyHash,
    grindHash,
  );
  assert.equal(unavailable.putRequests.length, 0);
  assert.equal(
    await unavailablePage
      .getByRole("region", { name: "Восстановление команд" })
      .count(),
    0,
  );
  assert.equal(
    await unavailablePage.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("coffee-platform:intent:v1:"),
        ).length,
    ),
    0,
  );
  await unavailablePage.close();

  const quantityPage = await context.newPage();
  const quantity = await installCommonMocks(quantityPage, {
    initialItem: true,
    initialItemGrind: true,
  });
  await quantityPage.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  await quantityPage.getByText("Помол: Мелкий помол").waitFor();
  await quantityPage
    .getByRole("textbox", { name: "Количество Капучино" })
    .fill("3");
  const quoteResponse = quantityPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/client-v1/pricing/quotes") &&
      response.request().method() === "POST",
  );
  const putResponse = quantityPage.waitForResponse(
    (response) =>
      /\/api\/client-v1\/orders\/ord_[^/]+\/items\/itm_[^/]+$/u.test(
        new URL(response.url()).pathname,
      ) && response.request().method() === "PUT",
  );
  await quantityPage.getByRole("button", { name: "Обновить" }).click();
  await Promise.all([quoteResponse, putResponse]);
  assert.equal(
    JSON.parse(quantity.quoteRequests[0] ?? "{}").lines[0].sourceGrindKeyHash,
    grindHash,
  );
  assert.equal(
    JSON.parse(quantity.putRequests[0] ?? "{}").sourceGrindKeyHash,
    grindHash,
  );
  await quantityPage.close();
}

async function quoteUsesCanonicalQuantity(
  context: BrowserContext,
): Promise<void> {
  for (const [requested, canonical] of [
    ["2.0", "2"],
    ["2.500", "2.5"],
  ] as const) {
    const page = await context.newPage();
    const telemetry = await installCommonMocks(page);
    await page.goto(`${origin}/app/catalog?orderRef=${orderRef}&q=капучино`, {
      waitUntil: "networkidle",
    });
    const quantity = page.getByRole("textbox", {
      name: "Количество для Капучино",
    });
    await quantity.fill(requested);
    const quoteResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/client-v1/pricing/quotes") &&
        response.request().method() === "POST",
    );
    const putResponse = page.waitForResponse(
      (response) =>
        /\/api\/client-v1\/orders\/ord_[^/]+\/items\/itm_[^/]+$/u.test(
          new URL(response.url()).pathname,
        ) && response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Добавить" }).click();
    const [, putResult] = await Promise.all([quoteResponse, putResponse]);
    const quote = JSON.parse(telemetry.quoteRequests[0] ?? "{}") as {
      lines?: Array<{ quantity?: string }>;
    };
    const put = JSON.parse(telemetry.putRequests[0] ?? "{}") as {
      quantity?: string;
    };
    assert.equal(quote.lines?.[0]?.quantity, requested);
    assert.equal(
      putResult.status(),
      200,
      "the fixture accepts only a PUT matching the selected quote quantity",
    );
    assert.equal(put.quantity, canonical);
    await page.close();
  }

  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, { initialItem: true });
  await page.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  await page
    .getByRole("textbox", { name: "Количество Капучино" })
    .fill("0.010");
  const quoteResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/client-v1/pricing/quotes") &&
      response.request().method() === "POST",
  );
  const putResponse = page.waitForResponse(
    (response) =>
      /\/api\/client-v1\/orders\/ord_[^/]+\/items\/itm_[^/]+$/u.test(
        new URL(response.url()).pathname,
      ) && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  const [, putResult] = await Promise.all([quoteResponse, putResponse]);
  const quote = JSON.parse(telemetry.quoteRequests[0] ?? "{}") as {
    lines?: Array<{ quantity?: string }>;
  };
  const put = JSON.parse(telemetry.putRequests[0] ?? "{}") as {
    quantity?: string;
  };
  assert.equal(quote.lines?.[0]?.quantity, "0.010");
  assert.equal(
    putResult.status(),
    200,
    "the fixture accepts only a PUT matching the selected quote quantity",
  );
  assert.equal(put.quantity, "0.01");
  await page.close();
}

async function malformedResponse(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await installCommonMocks(page, { malformedCustomers: true });
  await page.goto(`${origin}/app/customers?q=иван`, {
    waitUntil: "networkidle",
  });
  await page.getByText(/ответ не прошёл runtime validation/u).waitFor();
  await page.close();
}

async function serverValidationIsAssociated(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await installCommonMocks(page, { customerValidationError: true });
  await page.goto(`${origin}/app/customers`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Новый клиент" }).click();
  const displayName = page.getByRole("textbox", { name: "Имя", exact: true });
  await displayName.fill("Некорректное имя");
  await page
    .getByRole("textbox", { name: "Телефон", exact: true })
    .fill("+79999994567");
  await page.getByRole("button", { name: "Создать и выбрать" }).click();
  await page.getByText("Исправьте имя клиента").first().waitFor();
  assert.equal(await displayName.getAttribute("aria-invalid"), "true");
  assert.equal(
    await displayName.evaluate((node) => node === document.activeElement),
    true,
  );
  await page.close();
}

async function routeSemantics(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, { catalogNextCursor: true });
  const requests: Array<{ method: string; url: URL }> = [];
  page.on("request", (request) =>
    requests.push({ method: request.method(), url: new URL(request.url()) }),
  );
  await page.goto(`${origin}/app/customers`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Начните поиск клиента" }).waitFor();

  await page.goto(`${origin}/app/customers?q=%20иван%20`, {
    waitUntil: "networkidle",
  });
  try {
    await page
      .getByRole("heading", { name: "Иван Петров" })
      .waitFor({ timeout: 10_000 });
  } catch {
    throw new Error(
      `Нормализованный Customer deep link не показал результат: ${(await page.locator("body").textContent()) ?? ""}`,
    );
  }
  assert.equal(new URL(page.url()).searchParams.get("q"), "иван");
  await page.getByText("+799••••4567").waitFor();
  assert.equal(
    await page.getByText("+79999994567", { exact: true }).count(),
    0,
  );

  await page.goto(`${origin}/app/orders/new?customerRef=invalid`, {
    waitUntil: "networkidle",
  });
  await page.getByText(/корректный идентификатор клиента/u).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Создать черновик" }).count(),
    0,
  );
  assert.equal(telemetry.draftRequests.length, 0);

  const browseStart = requests.length;
  await page.goto(`${origin}/app/catalog`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Капучино" }).waitFor();
  const browse = requests.slice(browseStart);
  const firstPage = browse.find(
    (request) => request.url.pathname === "/api/client-v1/catalog/products",
  );
  assert.ok(firstPage);
  assert.equal(firstPage.url.searchParams.has("query"), false);
  assert.equal(firstPage.url.searchParams.get("availability"), "Available");
  assert.equal(firstPage.url.searchParams.get("limit"), "20");
  assert.equal(
    browse.some((request) =>
      request.url.pathname.startsWith("/api/client-v1/orders"),
    ),
    false,
  );
  assert.equal(
    browse.some((request) => request.method !== "GET"),
    false,
  );
  assert.equal(await page.getByLabel("Количество для Капучино").count(), 0);
  assert.equal(await page.getByLabel("Помол для Капучино").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Добавить" }).count(), 0);
  await page
    .getByRole("link", { name: "Выбрать клиента и создать заказ" })
    .waitFor();
  await page.getByRole("button", { name: "Следующая страница" }).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("cursor") === "catalog-next-page",
  );
  await expect
    .poll(() =>
      requests.some(
        (request) =>
          request.url.pathname === "/api/client-v1/catalog/products" &&
          request.url.searchParams.get("cursor") === "catalog-next-page" &&
          !request.url.searchParams.has("query"),
      ),
    )
    .toBe(true);
  await page.getByRole("textbox", { name: "Название товара" }).fill("кофе");
  await expect(page).toHaveURL((url) => url.searchParams.get("q") === "кофе");
  await expect
    .poll(() =>
      requests.some(
        (request) =>
          request.url.pathname === "/api/client-v1/catalog/products" &&
          request.url.searchParams.get("query") === "кофе" &&
          !request.url.searchParams.has("cursor"),
      ),
    )
    .toBe(true);
  assert.equal(new URL(page.url()).searchParams.has("cursor"), false);
  assert.equal(new URL(page.url()).searchParams.has("orderRef"), false);
  await page.getByRole("textbox", { name: "Название товара" }).fill("");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        window.history.pushState(window.history.state, "", "/app/catalog");
        window.history.back();
      }),
  );
  await expect(page).toHaveURL((url) => url.searchParams.get("q") === "кофе");
  await expect(
    page.getByRole("textbox", { name: "Название товара" }),
  ).toHaveValue("кофе");
  await page.getByRole("textbox", { name: "Название товара" }).fill("");
  await expect(page).toHaveURL((url) => !url.searchParams.has("q"));
  await page.goBack({ waitUntil: "networkidle" });
  await expect(page).toHaveURL((url) => url.searchParams.get("q") === "кофе");
  await expect(
    page.getByRole("textbox", { name: "Название товара" }),
  ).toHaveValue("кофе");
  await page.goForward({ waitUntil: "networkidle" });
  await expect(page).toHaveURL((url) => !url.searchParams.has("q"));
  await expect(
    page.getByRole("textbox", { name: "Название товара" }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Следующая страница" }).click();
  await page.getByLabel("Доступность").selectOption("Stopped");
  await page.getByRole("button", { name: "Найти" }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("availability") === "Stopped" &&
      !url.searchParams.has("cursor"),
  );
  assert.equal(telemetry.quoteRequests.length, 0);
  assert.equal(telemetry.putRequests.length, 0);

  for (const invalid of ["invalid", ""]) {
    const before = requests.length;
    await page.goto(`${origin}/app/catalog?orderRef=${invalid}`, {
      waitUntil: "networkidle",
    });
    await page.getByText("Не удалось открыть каталог заказа").waitFor();
    assert.equal(
      requests
        .slice(before)
        .some((request) => request.url.pathname.startsWith("/api/client-v1/")),
      false,
    );
  }

  await page.goto(`${origin}/app/catalog?orderRef=${orderRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("heading", { name: "Капучино" }).waitFor();
  assert.equal(telemetry.quoteRequests.length, 0);
  assert.equal(telemetry.putRequests.length, 0);
  assert.equal(
    new URL(page.url()).searchParams.has("availability"),
    false,
    "default Available should stay implicit in the URL",
  );
  await page.getByLabel("Доступность").selectOption("");
  await page.getByRole("button", { name: "Найти" }).click();
  assert.equal(
    new URL(page.url()).searchParams.has("availability"),
    true,
    "All should be explicit in the URL",
  );
  assert.equal(new URL(page.url()).searchParams.get("availability"), "");
  const availabilityFilter = page.getByLabel("Доступность");
  const waitForCatalogRequest = (query: string, availability?: string) =>
    page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/api/client-v1/catalog/products" &&
        url.searchParams.get("query") === query &&
        (availability === undefined
          ? !url.searchParams.has("availability")
          : url.searchParams.get("availability") === availability)
      );
    });
  const initialAllRequest = waitForCatalogRequest("капучино");
  await page.getByRole("textbox", { name: "Название товара" }).fill("капучино");
  await initialAllRequest;
  await page.getByLabel("Доступность").selectOption("Stopped");
  const stoppedRequest = waitForCatalogRequest("капучино", "Stopped");
  await page.getByRole("button", { name: "Найти" }).click();
  await stoppedRequest;
  assert.equal(
    new URL(page.url()).searchParams.get("availability"),
    "Stopped",
    "Stopped should be committed before history navigation",
  );
  await page.goBack({ waitUntil: "networkidle" });
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("availability") === "",
  );
  assert.equal(
    new URL(page.url()).searchParams.get("availability"),
    "",
    "Back should restore All in the URL",
  );
  await expect(
    availabilityFilter,
    "Back should restore All in the filter",
  ).toHaveValue("");
  await page.goForward({ waitUntil: "networkidle" });
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("availability") === "Stopped",
  );
  await expect(
    availabilityFilter,
    "Forward should restore the committed filter",
  ).toHaveValue("Stopped");
  await page.goBack({ waitUntil: "networkidle" });
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("availability") === "",
  );
  const debounceAllRequest = waitForCatalogRequest("латте");
  await page.getByRole("textbox", { name: "Название товара" }).fill("латте");
  await debounceAllRequest;
  await page.getByRole("heading", { name: "Капучино" }).waitFor();
  assert.equal(
    new URL(page.url()).searchParams.get("availability"),
    "",
    "debounced search must preserve All",
  );
  assert.equal(new URL(page.url()).searchParams.get("q"), "латте");

  await page.goto(`${origin}/app/orders/invalid`, { waitUntil: "networkidle" });
  await page.getByText(/Некорректный orderRef/u).waitFor();

  await page.goto(`${origin}/app/unknown`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Маршрут не найден" }).waitFor();
  await page.close();
}

async function missingOrderUsesRouteRecovery(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await installCommonMocks(page, { orderNotFound: true });
  await page.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  const heading = page.getByRole("heading", { name: "Заказ не найден" });
  const recoveryLink = page.getByRole("link", { name: "Перейти к клиентам" });
  await heading.waitFor();
  await recoveryLink.waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Обновить данные" }).count(),
    0,
  );
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(
      geometry.scrollWidth <= geometry.clientWidth + 1,
      `${width}px missing order overflow: ${JSON.stringify(geometry)}`,
    );
    const headingBox = await heading.boundingBox();
    assert.ok(
      headingBox &&
        headingBox.x >= 0 &&
        headingBox.x + headingBox.width <= width,
      `${width}px missing order heading clipped`,
    );
    await capture(page, `order-not-found-${width}.png`);
  }
  const violations = await new AxeBuilder({ page }).analyze();
  assert.equal(
    violations.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ).length,
    0,
  );
  await page.close();
}

async function fatalOrderRefetchHidesCachedCard(
  context: BrowserContext,
): Promise<void> {
  for (const status of [403, 404] as const) {
    const page = await context.newPage();
    const telemetry = await installCommonMocks(page, {
      aromaScenario: "UnknownOutcome",
      orderFailureOnRefetch: status,
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "networkidle",
    });
    try {
      await page
        .getByRole("heading", { name: "Иван Петров" })
        .waitFor({ timeout: 5_000 });
    } catch {
      throw new Error(
        `Initial Order Card missing for refetch ${status}: ${(await page.locator("body").textContent()) ?? ""}`,
      );
    }
    telemetry.armOrderFailure();
    await page.getByRole("button", { name: "Проверить состояние" }).click();
    if (status === 403) await page.getByText("Недостаточно прав").waitFor();
    else await page.getByRole("heading", { name: "Заказ не найден" }).waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "Иван Петров" }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "Проверить состояние" }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Запросить сверку AROMA" })
        .count(),
      0,
    );
    await page.close();
  }
}

async function browserBackDoesNotRepeatDraft(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page);
  await page.goto(`${origin}/app/customers?q=иван`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Выбрать" }).click();
  await page.getByRole("heading", { name: "Новый заказ" }).waitFor();
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/app/orders/${orderRef}`);
  assert.equal(telemetry.draftRequests.length, 1);
  await page.goBack({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/app/customers");
  assert.equal(
    telemetry.draftRequests.length,
    1,
    "Browser Back не должен повторять POST создания Draft",
  );
  await page.close();
}

async function staleQuoteAndConcurrentChange(
  context: BrowserContext,
): Promise<void> {
  const stalePage = await context.newPage();
  await installCommonMocks(stalePage, { initialItem: true, stalePut: true });
  await stalePage.goto(
    `${origin}/app/catalog?orderRef=${orderRef}&q=капучино`,
    { waitUntil: "networkidle" },
  );
  await stalePage.getByRole("heading", { name: "Капучино" }).waitFor();
  const addQuantity = stalePage.getByRole("textbox", {
    name: "Количество для Капучино",
  });
  await addQuantity.fill("2");
  await stalePage.getByRole("button", { name: "Добавить" }).click();
  await stalePage.getByText("Цена устарела").waitFor();
  assert.equal(await addQuantity.inputValue(), "2");
  await stalePage.close();

  const conflictPage = await context.newPage();
  const conflict = await installCommonMocks(conflictPage, {
    conflictPut: true,
    initialItem: true,
    orderRefetchUnavailableAfterConflict: true,
  });
  const orderCardStatuses: number[] = [];
  conflictPage.on("response", (response) => {
    if (
      new URL(response.url()).pathname ===
        `/api/client-v1/orders/${orderRef}` &&
      response.request().method() === "GET"
    )
      orderCardStatuses.push(response.status());
  });
  await conflictPage.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  const baselineOrderCardStatusCount = orderCardStatuses.length;
  const updateQuantity = conflictPage.getByRole("textbox", {
    name: "Количество Капучино",
  });
  await updateQuantity.fill("3");
  await conflictPage.getByRole("button", { name: "Обновить" }).click();
  const conflictDialog = conflictPage.getByRole("dialog", {
    name: "Заказ изменился на сервере",
  });
  await conflictDialog.waitFor();
  assert.equal(await updateQuantity.inputValue(), "3");
  assert.ok(
    baselineOrderCardStatusCount >= 1 &&
      orderCardStatuses.every((status) => status === 200),
  );
  await conflictDialog
    .getByRole("button", { name: "Обновить карточку" })
    .click();
  await expect
    .poll(() => orderCardStatuses.slice(baselineOrderCardStatusCount))
    .toEqual([503, 503]);
  await conflictPage
    .getByText("Не удалось проверить актуальность карточки", { exact: true })
    .waitFor();
  await conflictDialog.waitFor();
  assert.equal(
    await updateQuantity.inputValue(),
    "3",
    "failed refresh keeps the unsaved quantity and conflict choice",
  );
  assert.equal(
    conflict.putRequests.length,
    1,
    "failed refresh must not retry the PUT",
  );
  assert.equal(
    conflict.quoteRequests.length,
    1,
    "failed refresh must not create another quote",
  );
  await conflictDialog
    .getByRole("button", { name: "Обновить карточку" })
    .click();
  await conflictDialog.waitFor({ state: "hidden" });
  assert.deepEqual(
    orderCardStatuses.slice(baselineOrderCardStatusCount),
    [503, 503, 200],
  );
  await conflictPage
    .getByText("Версия заказа")
    .locator("..")
    .getByText("4", { exact: true })
    .waitFor();
  assert.equal(await updateQuantity.inputValue(), "3");
  assert.equal(
    conflict.putRequests.length,
    1,
    "successful fresh GET must not automatically retry the PUT",
  );
  await conflictPage
    .getByRole("button", { name: "Обновить", exact: true })
    .click();
  await conflictPage
    .getByText("Версия заказа")
    .locator("..")
    .getByText("5", { exact: true })
    .waitFor();
  assert.equal(
    conflict.putRequests.length,
    2,
    "only the explicit update after successful GET sends another PUT",
  );
  const recoveredPut = JSON.parse(conflict.putRequests[1] ?? "{}") as {
    expectedVersion?: string;
    quantity?: string;
  };
  assert.equal(recoveredPut.expectedVersion, "4");
  assert.equal(recoveredPut.quantity, "3");
  assert.notEqual(
    conflict.putIntentKeys[1],
    conflict.putIntentKeys[0],
    "explicit recovery must use a fresh idempotency key",
  );
  await conflictPage.close();

  const catalogConflictPage = await context.newPage();
  const catalogConflict = await installCommonMocks(catalogConflictPage, {
    conflictPut: true,
    initialItem: true,
  });
  await catalogConflictPage.goto(
    `${origin}/app/catalog?orderRef=${orderRef}&q=капучино`,
    { waitUntil: "networkidle" },
  );
  const catalogQuantity = catalogConflictPage.getByRole("textbox", {
    name: "Количество для Капучино",
  });
  const catalogGrind = catalogConflictPage.getByRole("combobox", {
    name: "Помол для Капучино",
  });
  await catalogQuantity.fill("3");
  await catalogGrind.selectOption(grindHash);
  await catalogConflictPage.getByRole("button", { name: "Добавить" }).click();
  const catalogConflictDialog = catalogConflictPage.getByRole("dialog", {
    name: "Заказ изменился на сервере",
  });
  await catalogConflictDialog.waitFor();
  assert.equal(catalogConflict.putRequests.length, 1);
  const firstCatalogPut = JSON.parse(
    catalogConflict.putRequests[0] ?? "{}",
  ) as {
    expectedVersion?: string;
    quantity?: string;
    sourceGrindKeyHash?: string;
  };
  assert.equal(firstCatalogPut.expectedVersion, "1");
  assert.equal(firstCatalogPut.quantity, "3");
  assert.equal(firstCatalogPut.sourceGrindKeyHash, grindHash);
  assert.ok(catalogConflict.putIntentKeys[0]);
  await catalogConflictDialog
    .getByRole("button", { name: "Обновить карточку" })
    .click();
  await catalogConflictDialog.waitFor({ state: "hidden" });
  assert.equal(
    catalogConflict.putRequests.length,
    1,
    "fresh GET must not automatically retry the failed PUT",
  );
  assert.equal(
    catalogConflict.quoteRequests.length,
    1,
    "fresh GET must not automatically create another quote",
  );
  assert.equal(await catalogQuantity.inputValue(), "3");
  assert.equal(await catalogGrind.inputValue(), grindHash);
  await catalogConflictPage.getByRole("button", { name: "Добавить" }).click();
  await catalogConflictPage.getByText("Товар добавлен").waitFor();
  assert.equal(
    catalogConflict.putRequests.length,
    2,
    "only an explicit Add starts another PUT",
  );
  const refreshedCatalogPut = JSON.parse(
    catalogConflict.putRequests[1] ?? "{}",
  ) as {
    expectedVersion?: string;
    quantity?: string;
    sourceGrindKeyHash?: string;
  };
  assert.equal(refreshedCatalogPut.expectedVersion, "4");
  assert.equal(refreshedCatalogPut.quantity, "3");
  assert.equal(refreshedCatalogPut.sourceGrindKeyHash, grindHash);
  assert.notEqual(
    catalogConflict.putIntentKeys[1],
    catalogConflict.putIntentKeys[0],
    "manual retry must use a fresh idempotency key",
  );
  await catalogConflictPage.close();
}

async function expiredQuoteCanBeRefreshedAtSameQuantity(
  context: BrowserContext,
): Promise<void> {
  const itemRef = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const page = await context.newPage();
  const telemetry = await installCommonMocks(page, {
    expiredDraftQuote: true,
    initialItem: true,
    initialItemGrind: true,
  });
  await page.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  const confirm = page.getByRole("button", {
    name: "Подтвердить заказ",
    exact: true,
  });
  const update = page.getByRole("button", { name: "Обновить", exact: true });
  const quantity = page.getByRole("textbox", { name: "Количество Капучино" });
  await expect(quantity).toHaveValue("2");
  assert.equal(
    await confirm.count(),
    0,
    "the reopened owner Draft allows editing but does not allow Confirm",
  );
  assert.equal(telemetry.quoteRequests.length, 0);
  assert.equal(telemetry.putRequests.length, 0);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
  await expect(quantity).toHaveValue("2");
  assert.equal(await confirm.count(), 0);
  assert.equal(
    telemetry.quoteRequests.length,
    0,
    "mount/refetch must not silently request a new quote",
  );
  assert.equal(
    telemetry.putRequests.length,
    0,
    "mount/refetch must not silently update the item",
  );
  await expect(update).toBeEnabled();

  const quoteResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/client-v1/pricing/quotes") &&
      response.request().method() === "POST",
  );
  const putResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/client-v1/orders/${orderRef}/items/${itemRef}` &&
      response.request().method() === "PUT",
  );
  await update.click();
  const [quote, put] = await Promise.all([quoteResponse, putResponse]);
  assert.equal(quote.status(), 201);
  assert.equal(put.status(), 200);
  const quoteRequest = JSON.parse(telemetry.quoteRequests[0] ?? "{}") as {
    lines?: Array<{ quantity?: string; sourceGrindKeyHash?: string }>;
  };
  const putRequest = JSON.parse(telemetry.putRequests[0] ?? "{}") as {
    expectedVersion?: string;
    quantity?: string;
    sourceGrindKeyHash?: string;
  };
  assert.equal(quoteRequest.lines?.[0]?.quantity, "2");
  assert.equal(quoteRequest.lines?.[0]?.sourceGrindKeyHash, grindHash);
  assert.equal(putRequest.expectedVersion, "2");
  assert.equal(putRequest.quantity, "2");
  assert.equal(putRequest.sourceGrindKeyHash, grindHash);
  await confirm.waitFor();
  assert.equal(
    telemetry.quoteRequests.length,
    1,
    "only the explicit Update requested a fresh quote",
  );
  assert.equal(
    telemetry.putRequests.length,
    1,
    "only the explicit Update sent the item PUT",
  );
  await page.close();
}

async function orderCardConfirmationRequiresSavedQuantities(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await installCommonMocks(page, { initialItem: true });
  let confirmPosts = 0;
  page.on("request", (request) => {
    if (
      request
        .url()
        .endsWith(`/api/client-v1/orders/${orderRef}/commands/confirm`) &&
      request.method() === "POST"
    )
      confirmPosts += 1;
  });
  await page.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  const quantity = page.getByRole("textbox", { name: "Количество Капучино" });
  const confirmTrigger = page.getByRole("button", {
    name: "Подтвердить заказ",
  });
  await quantity.fill("5");
  const unsavedWarning = page.getByText(
    "Сначала сохраните изменения количества",
    { exact: true },
  );
  await unsavedWarning.waitFor();
  assert.equal(await confirmTrigger.isDisabled(), true);
  assert.equal(
    confirmPosts,
    0,
    "unsaved quantity must not send a Confirm command",
  );
  await quantity.fill("2");
  await unsavedWarning.waitFor({ state: "detached" });
  assert.equal(
    await confirmTrigger.isDisabled(),
    false,
    "restoring the server quantity permits confirmation",
  );

  await quantity.fill("2.0");
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(quantity).toHaveValue("2");
  await unsavedWarning.waitFor({ state: "detached" });
  await confirmTrigger.click();
  const confirmDialog = page.getByRole("dialog", {
    name: "Подтвердить заказ?",
  });
  const confirmButton = confirmDialog.getByRole("button", {
    name: "Подтвердить",
    exact: true,
  });
  assert.equal(await confirmButton.isDisabled(), false);
  await confirmButton.click();
  await page.getByText("Подтверждён").waitFor();
  assert.equal(confirmPosts, 1);
  await page.close();

  const confirmedPage = await context.newPage();
  await installCommonMocks(confirmedPage, {
    conflictPut: true,
    conflictRefetchConfirmed: true,
    initialItem: true,
  });
  await confirmedPage.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  const confirmedQuantity = confirmedPage.getByRole("textbox", {
    name: "Количество Капучино",
  });
  await confirmedQuantity.fill("5");
  await confirmedPage
    .getByRole("button", { name: "Обновить", exact: true })
    .click();
  const conflictDialog = confirmedPage.getByRole("dialog", {
    name: "Заказ изменился на сервере",
  });
  await conflictDialog.waitFor();
  await conflictDialog
    .getByRole("button", { name: "Обновить карточку" })
    .click();
  await conflictDialog.waitFor({ state: "hidden" });
  await confirmedPage.getByText("Подтверждён").waitFor();
  assert.equal(
    await confirmedQuantity.inputValue(),
    "2",
    "a fresh non-editable card displays its server quantity",
  );
  assert.equal(await confirmedQuantity.isDisabled(), true);
  assert.equal(
    await confirmedPage
      .getByText("Сначала сохраните изменения количества", { exact: true })
      .count(),
    0,
  );
  await confirmedPage.close();
}

async function deleteItemReturnsFocusToItemsHeading(
  context: BrowserContext,
): Promise<void> {
  const page = await context.newPage();
  await installCommonMocks(page, { initialItem: true });
  await page.goto(`${origin}/app/orders/${orderRef}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Удалить позицию?" });
  const cancel = dialog.getByRole("button", { name: "Отмена" });
  assert.equal(
    await cancel.evaluate((node) => node === document.activeElement),
    true,
  );
  await dialog.getByRole("button", { name: "Удалить", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Черновик пока пуст" }).waitFor();
  const itemsHeading = page.getByRole("heading", { name: "Состав заказа" });
  const itemsHeadingHandle = await itemsHeading.elementHandle();
  assert.ok(itemsHeadingHandle);
  await page.waitForFunction(
    (node) => node === document.activeElement,
    itemsHeadingHandle,
  );
  await page.close();
}

async function orderRouteDialogsResetOnBrowserBack(
  context: BrowserContext,
): Promise<void> {
  const alternateOrderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const scenarios = [
    {
      options: { initialItem: true },
      alternateCard: orderCard("7", "Draft", true),
      dialogName: "Подтвердить заказ?",
      openDialog: (page: Page) =>
        page.getByRole("button", { name: "Подтвердить заказ" }).click(),
      prepareDialog: undefined,
      submitDialog: (page: Page) =>
        page
          .getByRole("dialog", { name: "Подтвердить заказ?" })
          .getByRole("button", { name: "Подтвердить", exact: true })
          .click(),
      commandMethod: "POST",
      commandPath: `/api/client-v1/orders/${orderRef}/commands/confirm`,
      expectedVersion: "2",
      responseStatus: 200,
    },
    {
      options: { initialItem: true },
      alternateCard: orderCard("7", "Draft", true),
      dialogName: "Удалить позицию?",
      openDialog: (page: Page) =>
        page.getByRole("button", { name: "Удалить", exact: true }).click(),
      prepareDialog: undefined,
      submitDialog: (page: Page) =>
        page
          .getByRole("dialog", { name: "Удалить позицию?" })
          .getByRole("button", { name: "Удалить", exact: true })
          .click(),
      commandMethod: "DELETE",
      commandPath: `/api/client-v1/orders/${orderRef}/items/itm_01ARZ3NDEKTSV4RRFFQ69G5FAV`,
      expectedVersion: "2",
      responseStatus: 200,
    },
    {
      options: {
        aromaScenario: "UnknownOutcome" as const,
        allowUnknownOutcomeReconciliation: true,
      },
      alternateCard: {
        ...orderCard("7", "Confirmed", true, "UnknownOutcome"),
        allowedActions: ["request-aroma-reconciliation"],
      },
      dialogName: "Запросить сверку AROMA?",
      openDialog: (page: Page) =>
        page.getByRole("button", { name: "Запросить сверку AROMA" }).click(),
      prepareDialog: async (page: Page, routeOrder: "A" | "B") => {
        const reason = page
          .getByRole("dialog", { name: "Запросить сверку AROMA?" })
          .getByRole("textbox", { name: "Причина" });
        if (routeOrder === "A")
          assert.equal(
            await reason.inputValue(),
            "",
            "reconciliation reason from B must be discarded on route change",
          );
        await reason.fill(
          routeOrder === "B" ? "Причина сверки B" : "Причина сверки A",
        );
      },
      submitDialog: (page: Page) =>
        page
          .getByRole("dialog", { name: "Запросить сверку AROMA?" })
          .getByRole("button", { name: "Отправить запрос" })
          .click(),
      commandMethod: "POST",
      commandPath: `/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,
      expectedVersion: "5",
      responseStatus: 202,
    },
  ];

  for (const scenario of scenarios) {
    const page = await context.newPage();
    const telemetry = await installCommonMocks(page, scenario.options);
    const commandRequests: Array<{ method: string; path: string }> = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path.includes("/commands/") ||
        (request.method() === "DELETE" && path.includes("/items/"))
      ) {
        commandRequests.push({ method: request.method(), path });
      }
    });
    await page.route(
      `**/api/client-v1/orders/${alternateOrderRef}`,
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await fulfillJson(route, {
          ...scenario.alternateCard,
          orderRef: alternateOrderRef,
        });
      },
    );

    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    const alternateCardRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/client-v1/orders/${alternateOrderRef}` &&
        response.request().method() === "GET",
    );
    await page.evaluate((href) => {
      window.history.pushState(window.history.state, "", href);
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: window.history.state }),
      );
    }, `/app/orders/${alternateOrderRef}`);
    await alternateCardRead;
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await scenario.openDialog(page);
    if (scenario.prepareDialog) await scenario.prepareDialog(page, "B");
    const dialog = page.getByRole("dialog", { name: scenario.dialogName });
    await dialog.waitFor();

    const ownerCardRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/client-v1/orders/${orderRef}` &&
        response.request().method() === "GET",
    );
    await page.goBack({ waitUntil: "domcontentloaded" });
    await ownerCardRead;
    await expect(dialog).toHaveCount(0);
    assert.equal(new URL(page.url()).pathname, `/app/orders/${orderRef}`);
    assert.deepEqual(
      commandRequests,
      [],
      `${scenario.dialogName} on B must not submit a command while returning to A`,
    );

    await scenario.openDialog(page);
    await page.getByRole("dialog", { name: scenario.dialogName }).waitFor();
    if (scenario.prepareDialog) await scenario.prepareDialog(page, "A");
    const expectedCommand = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === scenario.commandPath &&
        response.request().method() === scenario.commandMethod,
    );
    await scenario.submitDialog(page);
    const commandResponse = await expectedCommand;
    assert.equal(commandResponse.status(), scenario.responseStatus);
    if (scenario.commandMethod === "DELETE") {
      assert.equal(
        commandResponse.request().headers()["if-match-version"],
        scenario.expectedVersion,
      );
    } else {
      assert.equal(
        (
          commandResponse.request().postDataJSON() as {
            expectedVersion: string;
          }
        ).expectedVersion,
        scenario.expectedVersion,
      );
    }
    assert.deepEqual(commandRequests, [
      { method: scenario.commandMethod, path: scenario.commandPath },
    ]);
    if (scenario.dialogName === "Запросить сверку AROMA?") {
      assert.deepEqual(telemetry.reconciliationReasons, ["Причина сверки A"]);
      assert.deepEqual(telemetry.reconciliationExpectedVersions, ["5"]);
    }
    await page.close();
  }
}

function realtimeFixture() {
  const streams = new Set<ServerResponse>();
  const requests: IncomingMessage[] = [];
  let deny = false;
  return {
    streams,
    requests,
    deny(value: boolean) {
      deny = value;
    },
    handler(this: void, request: IncomingMessage, response: ServerResponse) {
      requests.push(request);
      if (deny) {
        response.writeHead(503, { "Content-Type": "application/problem+json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      response.write(": fixture native stream\nretry: 100\n\n");
      streams.add(response);
      response.on("close", () => streams.delete(response));
    },
    frame(name: string, data: unknown, id?: string) {
      const text = typeof data === "string" ? data : JSON.stringify(data);
      for (const response of streams)
        response.write(
          `${id ? `id: ${id}\n` : ""}event: ${name}\ndata: ${text}\n\n`,
        );
    },
    drop() {
      for (const response of streams) response.end();
    },
  };
}
type RealtimeFixture = ReturnType<typeof realtimeFixture>;
const readyFrame = {
  connectionId: "00000000-0000-4000-8000-000000000012",
  connectedAt: timestamp,
};
function hintFrame(version: string, ref = orderRef) {
  return {
    subjectType: "order",
    subjectRef: ref,
    ownerVersion: version,
    reason: "OrderChanged",
    correlationId: "00000000-0000-4000-8000-000000000012",
  };
}

async function auditNativeStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const audit: Array<{
      source: EventSource;
      url: string;
      closed: boolean;
      listeners: Set<EventListenerOrEventListenerObject>;
    }> = [];
    (window as Window & { __realtimeAudit?: typeof audit }).__realtimeAudit =
      audit;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        const record = {
          source: this,
          url: String(url),
          closed: false,
          listeners: new Set<EventListenerOrEventListenerObject>(),
        };
        audit.push(record);
        const add = this.addEventListener.bind(this);
        const remove = this.removeEventListener.bind(this);
        this.addEventListener = ((
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          record.listeners.add(listener);
          add(type, listener);
        }) as typeof this.addEventListener;
        this.removeEventListener = ((
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          record.listeners.delete(listener);
          remove(type, listener);
        }) as typeof this.removeEventListener;
        this.close = () => {
          record.closed = true;
          Native.prototype.close.call(this);
        };
      }
    };
  });
}
async function nativeAudit(page: Page) {
  return page.evaluate(() =>
    (
      (
        window as Window & {
          __realtimeAudit?: Array<{
            url: string;
            closed: boolean;
            listeners: Set<unknown>;
          }>;
        }
      ).__realtimeAudit ?? []
    ).map((record) => ({
      url: record.url,
      closed: record.closed,
      listeners: record.listeners.size,
    })),
  );
}
async function waitStream(fixture: RealtimeFixture): Promise<void> {
  await expect.poll(() => fixture.streams.size).toBe(1);
}
async function closeRealtimePage(
  page: Page,
  fixture: RealtimeFixture,
): Promise<void> {
  await page.close();
  await expect.poll(() => fixture.streams.size).toBe(0);
}

async function realtimeScenarios(
  context: BrowserContext,
  fixture: RealtimeFixture,
): Promise<number> {
  let executed = 0;
  const passed = (name: string) => {
    executed += 1;
    console.log(`realtime PASS ${executed}: ${name}`);
  };
  const orderPath = `**/api/client-v1/orders/${orderRef}`;
  // Actual native EventSource and first-ready GET/stream opening window.
  for (const inflight of [false, true]) {
    const page = await context.newPage();
    await auditNativeStreams(page);
    await installCommonMocks(page, { nativeRealtime: true });
    let reads = 0;
    let card = orderCard();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(orderPath, async (route) => {
      reads += 1;
      const body = structuredClone(card);
      if (inflight && reads === 1) await gate;
      await fulfillJson(route, body);
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await waitStream(fixture);
    await expect.poll(() => reads).toBe(1);
    if (!inflight)
      await page
        .getByText("версия представления 1", { exact: false })
        .waitFor();
    card = orderCard("2");
    fixture.frame("stream-ready.v1", readyFrame);
    release();
    await page.getByText("версия представления 2", { exact: false }).waitFor();
    assert.equal(reads, 2);
    await page
      .getByLabel("Соединение обновлений")
      .getByText("Подключено", { exact: true })
      .waitFor();
    const audit = await nativeAudit(page);
    assert.equal(
      audit.length,
      1,
      "one native constructor, not a reconnect loop",
    );
    assert.deepEqual(
      audit.map((r) => r.url),
      ["/events"],
    );
    assert.ok(
      fixture.requests
        .at(-1)
        ?.headers.cookie?.includes("__Host-coffee-csrf=test-csrf-token"),
    );
    for (const header of [
      "authorization",
      "x-actor-ref",
      "x-user-id",
      "x-correlation-id",
    ])
      assert.equal(fixture.requests.at(-1)?.headers[header], undefined);
    passed(
      inflight
        ? "first-ready-during-initial-get-race"
        : "first-ready-refetches-missed-owner-change-native-cookie",
    );
    await closeRealtimePage(page, fixture);
  }
  // Strict runtime wire validation, exact query/version semantics and monotonic GET.
  {
    const page = await context.newPage();
    await captureBrowserTelemetry(page);
    await installCommonMocks(page, { nativeRealtime: true });
    let reads = 0;
    const correlationIds: string[] = [];
    let card = { ...orderCard("3"), version: "999" };
    await page.route(orderPath, (route) => {
      reads += 1;
      correlationIds.push(route.request().headers()["x-correlation-id"] ?? "");
      return fulfillJson(route, card);
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await waitStream(fixture);
    for (const data of [
      "not JSON",
      "null",
      "[]",
      { ...hintFrame("4"), ownerVersion: 4 },
      { ...hintFrame("4"), ownerVersion: "04" },
      { ...hintFrame("4"), subjectRef: customerRef },
      { ...hintFrame("4"), subjectType: "customer" },
      { ...hintFrame("4"), reason: "Paid" },
      { ...hintFrame("4"), correlationId: "bad" },
      { ...hintFrame("4"), items: [] },
      { ...hintFrame("4"), allowedActions: ["confirm"] },
      { ...hintFrame("4"), customer: { displayName: "Injected" } },
      "x".repeat(2049),
    ])
      fixture.frame("resource-invalidated.v1", data);
    fixture.frame("stream-ready.v1", { ...readyFrame, items: [] });
    fixture.frame("stream-reset.v1", { reason: "OTHER" });
    fixture.frame("stream-ready.v1", {
      ...readyFrame,
      connectedAt: "2026-02-30T00:00:00Z",
    });
    fixture.frame("unknown.v1", hintFrame("4"));
    fixture.frame("resource-invalidated.v1", hintFrame("3"));
    fixture.frame("resource-invalidated.v1", hintFrame("2"));
    await page.waitForTimeout(200);
    assert.equal(
      reads,
      1,
      "malformed/business fields/covered versions cannot trigger an owner GET",
    );
    assert.equal(await page.getByText("Injected").count(), 0);
    card = { ...orderCard("4"), version: "999" };
    fixture.frame("resource-invalidated.v1", hintFrame("4"));
    await page.getByText("версия представления 4", { exact: false }).waitFor();
    assert.equal(
      reads,
      2,
      "dedup uses projectionVersion, not Order.version=999",
    );
    assert.equal(correlationIds[1], hintFrame("4").correlationId);
    assert.notEqual(correlationIds[0], correlationIds[1]);
    const events = await page.evaluate(
      () =>
        (window as Window & { __coffeeTelemetry?: BrowserTelemetryEvent[] })
          .__coffeeTelemetry ?? [],
    );
    assert.ok(
      events.some(
        (event) =>
          event.name === "ui.query.result" &&
          event.correlationId === correlationIds[1],
      ),
    );
    fixture.frame("resource-invalidated.v1", hintFrame("4"));
    fixture.frame("resource-invalidated.v1", hintFrame("3"));
    await page.waitForTimeout(150);
    assert.equal(reads, 2);
    card = { ...orderCard("2"), version: "999" };
    fixture.frame("resource-invalidated.v1", hintFrame("5"));
    await expect.poll(() => reads).toBe(3);
    await page.waitForTimeout(150);
    await page.getByText("версия представления 4", { exact: false }).waitFor();
    passed(
      "strict-metadata-schema-no-cache-patch-projection-only-dedup-monotonic-get",
    );
    await closeRealtimePage(page, fixture);
  }
  // Populate inactive details and Customer/Catalog queries through real routes.
  {
    const page = await context.newPage();
    await installCommonMocks(page, { nativeRealtime: true });
    const other = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    let reads = 0,
      otherReads = 0,
      searchReads = 0;
    page.on("request", (request) => {
      if (/\/(customers|catalog\/products)(?:\?|$)/u.test(request.url()))
        searchReads += 1;
    });
    await page.route(orderPath, (route) => {
      reads += 1;
      return fulfillJson(route, orderCard());
    });
    await page.route(`**/api/client-v1/orders/${other}`, (route) => {
      otherReads += 1;
      return fulfillJson(route, { ...orderCard(), orderRef: other });
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await waitStream(fixture);
    await page
      .getByRole("link", { name: "Клиенты", exact: true })
      .first()
      .click();
    await page.getByRole("textbox", { name: "Поиск клиента" }).fill("Иван");
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await page.evaluate((ref) => {
      history.pushState(null, "", `/app/catalog?orderRef=${ref}&q=coffee`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, orderRef);
    await page.getByRole("heading", { name: "Капучино" }).waitFor();
    const catalogReads = searchReads;
    const activeReads = reads;
    fixture.frame("stream-ready.v1", readyFrame);
    await expect.poll(() => reads).toBe(activeReads + 1);
    await page.waitForTimeout(100);
    assert.equal(
      searchReads,
      catalogReads,
      "ready cannot invalidate active Catalog or cached Customer search",
    );
    await page
      .getByRole("link", { name: "Клиенты", exact: true })
      .first()
      .click();
    await page.getByRole("heading", { name: "Клиенты", exact: true }).waitFor();
    const inactiveReads = reads;
    fixture.frame("stream-ready.v1", readyFrame);
    fixture.frame("stream-reset.v1", { reason: "REPLAY_UNAVAILABLE" });
    fixture.frame("resource-invalidated.v1", hintFrame("2"));
    await page.waitForTimeout(200);
    assert.equal(reads, inactiveReads, "inactive Order must not eagerly fetch");
    const beforeSearch = searchReads;
    fixture.frame("stream-reset.v1", { reason: "REPLAY_UNAVAILABLE" });
    await page.waitForTimeout(100);
    assert.equal(searchReads, beforeSearch);
    // Native history navigation, not full reload, keeps one stream and existing cache.
    await page.evaluate((ref) => {
      history.pushState(null, "", `/app/orders/${ref}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, other);
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await expect.poll(() => otherReads).toBe(1);
    fixture.frame("resource-invalidated.v1", hintFrame("2"));
    fixture.frame(
      "resource-invalidated.v1",
      hintFrame("2", "ord_01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    );
    await page.waitForTimeout(100);
    assert.equal(otherReads, 1);
    assert.equal(reads, inactiveReads);
    fixture.frame("stream-reset.v1", { reason: "REPLAY_UNAVAILABLE" });
    await expect.poll(() => otherReads).toBe(2);
    assert.equal(reads, inactiveReads);
    assert.equal(searchReads, beforeSearch);
    passed(
      "reset-existing-detail-prefix-exact-hint-isolation-no-inactive-fetch",
    );
    await closeRealtimePage(page, fixture);
  }
  // SSE owner reads preserve fatal barriers; older/divergent successful HTTP is not recovery.
  for (const fatal of [403, 404] as const) {
    const page = await context.newPage();
    await installCommonMocks(page, { nativeRealtime: true });
    let reads = 0;
    let mode: number | "older" | "divergent" = 200;
    await page.route(orderPath, (route) => {
      reads += 1;
      if (mode === "older") return fulfillJson(route, orderCard("1"));
      if (mode === "divergent")
        return fulfillJson(route, {
          ...orderCard("3"),
          customer: { customerRef, displayName: "Injected private" },
        });
      if (mode === 200) return fulfillJson(route, orderCard("3"));
      return fulfillJson(
        route,
        {
          type: "about:blank",
          title: "Denied",
          status: mode,
          code: mode === 404 ? "ORDER_NOT_FOUND" : "PERMISSION_DENIED",
          detail: "Denied",
          instance: `/api/client-v1/orders/${orderRef}`,
          correlationId: readyFrame.connectionId,
          errors: [],
        },
        mode,
      );
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await waitStream(fixture);
    mode = fatal;
    fixture.frame("resource-invalidated.v1", hintFrame("4"));
    await expect
      .poll(async () =>
        page.getByRole("heading", { name: "Иван Петров" }).count(),
      )
      .toBe(0);
    for (const next of ["older", "divergent", 503] as const) {
      mode = next;
      const before = reads;
      fixture.frame("resource-invalidated.v1", hintFrame("4"));
      await expect.poll(() => reads).toBeGreaterThan(before);
      await page.waitForTimeout(650);
      assert.equal(
        await page.getByRole("heading", { name: "Иван Петров" }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("heading", { name: "Injected private" }).count(),
        0,
      );
    }
    mode = 200;
    fixture.frame("resource-invalidated.v1", hintFrame("4"));
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    passed(
      `fatal-${fatal}-older-divergent-unavailable-privacy-barrier-accepted-owner-recovery`,
    );
    await closeRealtimePage(page, fixture);
  }
  // Malformed owner success and equal-version divergence hide old private data;
  // only an accepted current owner response clears that protocol barrier.
  {
    const page = await context.newPage();
    await installCommonMocks(page, { nativeRealtime: true });
    let reads = 0;
    let mode: "current" | "malformed" | "older" | "divergent" | "newer" =
      "current";
    await page.route(orderPath, (route) => {
      reads += 1;
      if (mode === "malformed")
        return fulfillJson(route, {
          ...orderCard("3"),
          allowedActions: "confirm",
        });
      if (mode === "older") return fulfillJson(route, orderCard("1"));
      if (mode === "divergent")
        return fulfillJson(route, {
          ...orderCard("3"),
          customer: { customerRef, displayName: "Injected private" },
        });
      return fulfillJson(route, orderCard(mode === "newer" ? "4" : "3"));
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await waitStream(fixture);
    mode = "malformed";
    fixture.frame("resource-invalidated.v1", hintFrame("4"));
    await expect
      .poll(async () =>
        page.getByRole("heading", { name: "Иван Петров" }).count(),
      )
      .toBe(0);
    for (const next of ["older", "divergent"] as const) {
      mode = next;
      const before = reads;
      fixture.frame("resource-invalidated.v1", hintFrame("4"));
      await expect.poll(() => reads).toBeGreaterThan(before);
      await page.waitForTimeout(100);
      assert.equal(
        await page.getByRole("heading", { name: "Иван Петров" }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("heading", { name: "Injected private" }).count(),
        0,
      );
    }
    mode = "current";
    fixture.frame("stream-reset.v1", { reason: "REPLAY_UNAVAILABLE" });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    mode = "divergent";
    fixture.frame("resource-invalidated.v1", hintFrame("4"));
    await expect
      .poll(async () =>
        page.getByRole("heading", { name: "Иван Петров" }).count(),
      )
      .toBe(0);
    mode = "newer";
    fixture.frame("stream-ready.v1", readyFrame);
    await page.getByText("версия представления 4", { exact: false }).waitFor();
    passed(
      "fatal-owner-protocol-malformed-divergent-private-data-hidden-accepted-recovery",
    );
    await closeRealtimePage(page, fixture);
  }
  {
    const page = await context.newPage();
    await auditNativeStreams(page);
    const controls = await installCommonMocks(page, { nativeRealtime: true });
    let expired = false;
    await page.route(orderPath, (route) =>
      expired
        ? fulfillJson(
            route,
            {
              type: "about:blank",
              title: "Expired",
              status: 401,
              code: "AUTHENTICATION_REQUIRED",
              detail: "Session ended",
              instance: `/api/client-v1/orders/${orderRef}`,
              correlationId: readyFrame.connectionId,
              errors: [],
            },
            401,
          )
        : fulfillJson(route, orderCard()),
    );
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await waitStream(fixture);
    controls.setSessionAvailable(false);
    expired = true;
    fixture.frame("resource-invalidated.v1", hintFrame("2"));
    await page.getByText("Требуется вход", { exact: true }).waitFor();
    await expect
      .poll(
        async () => (await nativeAudit(page)).filter((r) => !r.closed).length,
      )
      .toBe(0);
    assert.ok((await nativeAudit(page)).every((r) => r.listeners === 0));
    assert.equal(
      await page.getByRole("heading", { name: "Иван Петров" }).count(),
      0,
    );
    passed(
      "owner-401-invalidates-session-closes-stream-and-hides-private-card",
    );
    await closeRealtimePage(page, fixture);
  }
  // Session switch while SSE-driven owner GET is in flight, stale frame, and logout.
  {
    const page = await context.newPage();
    await auditNativeStreams(page);
    await page.clock.install();
    const controls = await installCommonMocks(page, { nativeRealtime: true });
    let reads = 0,
      held = false,
      release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(orderPath, async (route) => {
      reads += 1;
      const stale = held && reads === 2;
      if (stale) await gate;
      await fulfillJson(route, orderCard(stale ? "9" : "1"));
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await waitStream(fixture);
    held = true;
    fixture.frame("resource-invalidated.v1", hintFrame("9"));
    await expect.poll(() => reads).toBe(2);
    await page
      .getByLabel("Соединение обновлений")
      .getByText("Обновление состояния")
      .waitFor();
    await page.setViewportSize({ width: 375, height: 900 });
    const width = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      width.scroll <= width.client + 1,
      `realtime status must reflow at 375px: ${JSON.stringify(width)}`,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    controls.switchActor();
    await page.clock.fastForward(31_000);
    await page.getByText("operator-2", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Клиенты", exact: true }).waitFor();
    release();
    await page.clock.fastForward(500);
    const audit = await nativeAudit(page);
    assert.equal(audit.length, 2);
    assert.equal(audit[0]?.closed, true);
    assert.equal(audit[0]?.listeners, 0);
    assert.equal(audit[1]?.closed, false);
    const readsAfterSwitch = reads;
    await page.evaluate((data) => {
      const audit = (
        window as Window & { __realtimeAudit?: Array<{ source: EventSource }> }
      ).__realtimeAudit;
      audit?.[0]?.source.dispatchEvent(
        new MessageEvent("resource-invalidated.v1", {
          data: JSON.stringify(data),
        }),
      );
    }, hintFrame("10"));
    await page.clock.fastForward(500);
    assert.equal(reads, readsAfterSwitch);
    assert.equal(
      await page.getByText("версия представления 9", { exact: false }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("heading", { name: "Иван Петров" }).count(),
      0,
    );
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await page
      .getByRole("button", { name: "Завершить сессию", exact: true })
      .click();
    await page.getByText("Требуется вход", { exact: true }).waitFor();
    await expect
      .poll(
        async () => (await nativeAudit(page)).filter((r) => !r.closed).length,
      )
      .toBe(0);
    assert.ok((await nativeAudit(page)).every((r) => r.listeners === 0));
    await page.clock.fastForward(31_000);
    assert.equal(
      await page
        .getByText("Автоматические обновления недоступны", { exact: true })
        .count(),
      0,
    );
    passed(
      "session-switch-aborts-old-refetch-removes-listeners-stale-frames-logout-cleans-timer",
    );
    await closeRealtimePage(page, fixture);
  }
  // Native retry + Last-Event-ID, then 30-second transport banner/manual safe owner GET.
  {
    const page = await context.newPage();
    await auditNativeStreams(page);
    await page.clock.install();
    await installCommonMocks(page, { nativeRealtime: true });
    let reads = 0,
      posts = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET") posts += 1;
    });
    await page.route(orderPath, (route) => {
      reads += 1;
      return fulfillJson(route, orderCard());
    });
    await page.goto(`${origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await waitStream(fixture);
    const msg = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    fixture.frame("resource-invalidated.v1", hintFrame("1"), msg);
    await page.waitForTimeout(150);
    const requestCount = fixture.requests.length;
    fixture.drop();
    await expect
      .poll(() => fixture.requests.length)
      .toBeGreaterThan(requestCount);
    await waitStream(fixture);
    assert.equal(fixture.requests.at(-1)?.headers["last-event-id"], msg);
    assert.equal(
      (await nativeAudit(page)).length,
      1,
      "native reconnect reuses the same EventSource",
    );
    fixture.frame("stream-ready.v1", readyFrame);
    await expect.poll(() => reads).toBe(2);
    await page.clock.pauseAt(
      await page.evaluate(() =>
        Math.ceil(performance.timeOrigin + performance.now()),
      ),
    );
    fixture.deny(true);
    fixture.drop();
    await page
      .getByLabel("Соединение обновлений")
      .getByText("Переподключение")
      .waitFor();
    await page.clock.fastForward(29_999);
    assert.equal(
      await page
        .getByText("Автоматические обновления недоступны", { exact: true })
        .count(),
      0,
    );
    await page.clock.fastForward(1);
    await page
      .getByText("Автоматические обновления недоступны", { exact: true })
      .waitFor();
    const before = reads;
    await page
      .getByRole("button", { name: "Проверить данные заказов" })
      .click();
    await expect.poll(() => reads).toBe(before + 1);
    assert.equal(posts, 0, "manual fallback never resubmits commands");
    await page.getByText("Черновик", { exact: true }).waitFor();
    assert.equal((await nativeAudit(page)).length, 1);
    passed(
      "native-retry-last-event-id-30s-banner-manual-owner-get-not-business-state",
    );
    // Clock is context-wide: subsequent non-realtime pages need running timers.
    await page.clock.resume();
    await closeRealtimePage(page, fixture);
    fixture.deny(false);
  }
  assert.ok(executed >= 8, "realtime group cannot report a vacuous pass");
  return executed;
}

async function main(): Promise<void> {
  const fixture = realtimeFixture();
  const server: PreviewServer = await preview({
    configFile: resolve(appRoot, "vite.config.ts"),
    preview: { host: "127.0.0.1", port, strictPort: true },
    root: appRoot,
    plugins: [
      {
        name: "native-realtime-fixture",
        configurePreviewServer(server) {
          server.middlewares.use("/events", fixture.handler);
        },
      },
    ],
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const browserErrors: string[] = [];
    const externalRequests: string[] = [];
    context.on("page", (page) => {
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          !message.text().includes("Failed to load resource")
        )
          browserErrors.push(message.text());
      });
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("request", (request) => {
        const requestUrl = new URL(request.url());
        if (requestUrl.origin !== origin) externalRequests.push(request.url());
      });
    });
    await context.addCookies([
      {
        domain: "localhost",
        name: "__Host-coffee-csrf",
        path: "/",
        secure: true,
        value: "test-csrf-token",
      },
    ]);
    const group = process.env.WEB_TEST_GROUP ?? "all";
    if (["all", "realtime"].includes(group)) {
      const executed = await realtimeScenarios(context, fixture);
      console.log(`realtime: executed ${executed} scenarios`);
    }
    if (["all", "accessibility", "routes"].includes(group))
      await happyPath(context);
    if (["all", "routes"].includes(group)) {
      await orderRouteDialogsResetOnBrowserBack(context);
      await routeSemantics(context);
      await missingOrderUsesRouteRecovery(context);
      await fatalOrderRefetchHidesCachedCard(context);
      await browserBackDoesNotRepeatDraft(context);
      await staleQuoteAndConcurrentChange(context);
      await expiredQuoteCanBeRefreshedAtSameQuantity(context);
      await quoteUsesCanonicalQuantity(context);
      await orderCardConfirmationRequiresSavedQuantities(context);
      await deleteItemReturnsFocusToItemsHeading(context);
      await actorChangeClearsCustomerFormAfterPeriodicSessionCheck(context);
      await unavailableSessionHidesPrivateRoutes(context);
      await forbiddenResourceKeepsSessionAndShowsRightsError(context);
      await cachedCustomersAreHiddenAfterForbiddenRefetch(context);
      await cachedCatalogRefetchKeepsAccessAndAvailabilitySeparate(context);
      await unavailableDependenciesPreserveOperatorContext(context);
      await grindSelectionFlows(context);
      await aromaBlockedAndUnknownOutcomeUseOwnerActions(context);
    }
    if (["all", "idempotency"].includes(group)) {
      await ambiguousRecovery(context);
      await actorSwitchBlocksRecovery(context);
      await replayFreshSessionBlocksActorConfusion(context);
      await replayRejectsTerminalFromAnotherOperation(context);
      await sameActorReauthPreservesExplicitRecovery(context);
      await missingCsrfBlocksMutation(context);
      await freshSessionBlocksActorConfusion(context);
      await csrfChangeDuringIntentPreparationBlocksMutation(context);
      await logoutDuringFingerprintDoesNotCreateIntent(context);
      await mismatchedProblemStatusRetainsIntent(context);
      await reconciliationAcceptanceCannotBeResubmitted(context);
      await reconciliationUnlocksAfterNewOwnerProjection(context);
      await reconciliationStaysBlockedDuringOwnerRefresh(context);
      await replayDoesNotPublishHistoricalCard(context);
      await replayVerificationUpdatesExactOrderQuery(context);
      await lateMutationCannotRestoreAfterFatalOwnerRead(context);
      await explicitLogoutClearsRecovery(context);
      await expiredSessionHidesPrivateRoutes(context);
    }
    if (["all", "routes"].includes(group)) await malformedResponse(context);
    if (["all", "accessibility"].includes(group))
      await serverValidationIsAssociated(context);
    assert.deepEqual(
      browserErrors,
      [],
      `unexpected browser errors: ${browserErrors.join(" | ")}`,
    );
    assert.deepEqual(
      externalRequests,
      [],
      `unexpected external requests: ${externalRequests.join(" | ")}`,
    );
    await context.close();
  } finally {
    await browser?.close();
    await server.close();
  }
}

type ServedControls = {
  actor: (actorRef: string, permissions?: string[]) => void;
  failures: (next: Record<string, number>) => void;
  reset: () => void;
  conflict: () => void;
  divergentProjection: () => void;
  olderProjection: () => void;
  hold: () => void;
  release: () => void;
  records: () => Array<{ operation?: string; method?: string }>;
  expiry: () => Promise<void>;
  expire: () => void;
};

export async function runServedBrowser(
  context: BrowserContext,
  base: string,
  evidence: string,
  controls: ServedControls,
): Promise<void> {
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const network: Array<{ method: string; path: string; status: number }> = [];
  page.on("response", (response) =>
    network.push({
      method: response.request().method(),
      path: new URL(response.url()).pathname,
      status: response.status(),
    }),
  );
  try {
    const absent = await context.request.get(`${base}/auth/session`);
    assert.equal(absent.status(), 401);
    const login = await context.request.get(
      `${base}/auth/login?returnTo=/app/customers`,
      { maxRedirects: 0 },
    );
    assert.equal(login.status(), 303);
    const authorization = new URL(login.headers()["location"] ?? "");
    const state = authorization.searchParams.get("state");
    assert.ok(state);
    await page.goto(
      `${base}/auth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(state)}`,
    );
    const cookies = await context.cookies(base);
    for (const [name, httpOnly] of [
      ["__Host-coffee-session", true],
      ["__Host-coffee-csrf", false],
    ] as const) {
      const cookie = cookies.find((entry) => entry.name === name);
      assert.ok(cookie);
      assert.equal(cookie.secure, true);
      assert.equal(cookie.httpOnly, httpOnly);
      assert.equal(cookie.path, "/");
      assert.equal(cookie.sameSite, "Lax");
    }
    const session = await context.request.get(`${base}/auth/session`);
    network.push({
      method: "GET",
      path: "/auth/session",
      status: session.status(),
    });
    assert.equal(
      session.status(),
      200,
      "actual production session must be available after successful OIDC callback",
    );
    await page.getByRole("heading", { name: "Клиенты", exact: true }).waitFor();
    for (const [route, heading] of [
      ["/app/customers", "Клиенты"],
      ["/app/catalog", "Поиск товаров"],
      ["/app/orders/new", "Новый заказ"],
      [`/app/orders/${orderRef}`, "Иван Петров"],
    ]) {
      assert.equal((await page.goto(`${base}${route}`))?.status(), 200);
      await page.getByText(heading!, { exact: true }).first().waitFor();
      if (route === "/app/catalog")
        await page.getByRole("heading", { name: "Капучино" }).waitFor();
      assert.equal((await page.reload())?.status(), 200);
      await page.getByText(heading!, { exact: true }).first().waitFor();
    }
    const assetPaths = [
      ...new Set(
        network
          .filter(
            (r) => r.path.startsWith("/assets/") && /\.(js|css)$/u.test(r.path),
          )
          .map((r) => r.path),
      ),
    ];
    assert.ok(
      assetPaths.some((p) => p.endsWith(".js")) &&
        assetPaths.some((p) => p.endsWith(".css")),
    );
    for (const assetPath of assetPaths) {
      assert.match(assetPath, /-[A-Za-z0-9_-]{8,}\.(js|css)$/u);
      const asset = await context.request.get(`${base}${assetPath}`);
      assert.equal(asset.status(), 200);
      assert.match(asset.headers()["cache-control"] ?? "", /immutable/u);
      assert.ok((await asset.body()).length > 0);
    }
    for (const route of [
      "/assets/missing.js",
      "/api/client-v1/missing",
      "/events/missing",
    ]) {
      const response = await context.request.get(`${base}${route}`);
      assert.equal(response.status(), 404);
      assert.equal((await response.text()).includes('<div id="root">'), false);
    }
    await page.goto(`${base}/`);
    await page.getByRole("heading", { name: "Клиенты", exact: true }).waitFor();
    const tabTo = async (
      locator: ReturnType<Page["getByRole"]>,
    ): Promise<void> => {
      await locator.waitFor({ state: "visible" });
      for (let i = 0; i < 100; i += 1) {
        if (
          await locator.evaluate(
            (node) =>
              node === document.activeElement ||
              node.contains(document.activeElement),
          )
        )
          return;
        await page.keyboard.press("Tab");
      }
      assert.fail(`Keyboard focus could not reach ${String(locator)}`);
    };
    const press = async (
      locator: ReturnType<Page["getByRole"]>,
    ): Promise<void> => {
      await tabTo(locator);
      await page.keyboard.press("Enter");
    };
    const type = async (
      locator: ReturnType<Page["getByRole"]>,
      value: string,
    ): Promise<void> => {
      await tabTo(locator);
      await page.keyboard.press("Control+A");
      await page.keyboard.type(value);
    };
    await press(page.getByRole("button", { name: "Новый клиент" }));
    const dialog = page.getByRole("dialog", { name: "Новый клиент" });
    await type(
      dialog.getByRole("textbox", { name: "Имя", exact: true }),
      "Иван Петров",
    );
    await type(
      dialog.getByRole("textbox", { name: "Телефон", exact: true }),
      "+79991234567",
    );
    await press(dialog.getByRole("button", { name: "Создать и выбрать" }));
    await page.getByRole("heading", { name: "Новый заказ" }).waitFor();
    await press(page.getByRole("button", { name: "Создать черновик" }));
    await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
    await press(page.getByRole("link", { name: "Открыть каталог" }));
    await page.getByRole("heading", { name: "Поиск товаров" }).waitFor();
    await type(
      page.getByRole("textbox", { name: "Название товара" }),
      "капучино",
    );
    await press(page.getByRole("button", { name: "Найти" }));
    await page.getByRole("heading", { name: "Капучино" }).waitFor();
    await type(
      page.getByRole("textbox", { name: "Количество для Капучино" }),
      "2",
    );
    await press(page.getByRole("button", { name: "Добавить" }));
    await page.getByText("Товар добавлен", { exact: true }).waitFor();
    await press(page.getByRole("link", { name: "К заказу" }).first());
    await page.getByText("500,00 ₽").first().waitFor();
    await press(page.getByRole("button", { name: "Подтвердить заказ" }));
    await press(
      page
        .getByRole("dialog", { name: "Подтвердить заказ?" })
        .getByRole("button", { name: "Подтвердить", exact: true }),
    );
    await page.getByText("Подтверждён").waitFor();
    await page.screenshot({
      path: resolve(evidence, "served-happy-path.png"),
      fullPage: true,
    });
    await press(page.getByRole("button", { name: "Запросить сверку AROMA" }));
    const reconciliation = page.getByRole("dialog", {
      name: "Запросить сверку AROMA?",
    });
    await type(
      reconciliation.getByRole("textbox", { name: "Причина" }),
      "Проверка isolated fixture",
    );
    await press(
      reconciliation.getByRole("button", { name: "Отправить запрос" }),
    );
    await reconciliation.waitFor({ state: "hidden" });
    const scenarios: Array<{
      name: string;
      status: string;
      boundary?: string;
    }> = [
      "default-clock-crypto-login-keyboard-happy-path",
      "four-deep-links-and-reload-render-ui",
      "fresh-built-hashed-assets-immutable",
      "missing-assets-api-events-no-spa-fallback",
      "absent-session-native-401",
      "root-navigation",
    ].map((name) => ({ name, status: "pass" }));
    const { writeFile } = await import("node:fs/promises");
    const passed = async (name: string, boundary?: string): Promise<void> => {
      scenarios.push({
        name,
        status: "pass",
        ...(boundary ? { boundary } : {}),
      });
      await page.screenshot({
        path: resolve(evidence, `${name}.png`),
        fullPage: true,
      });
      await writeFile(
        resolve(evidence, "scenarios.json"),
        JSON.stringify(scenarios, null, 2),
      );
    };
    const loginWithoutNavigation = async (): Promise<void> => {
      const start = await context.request.get(
        `${base}/auth/login?returnTo=/app/customers`,
        { maxRedirects: 0 },
      );
      assert.equal(start.status(), 303);
      const value = new URL(start.headers()["location"] ?? "").searchParams.get(
        "state",
      );
      assert.ok(value);
      const callback = await context.request.get(
        `${base}/auth/callback?state=${encodeURIComponent(value)}&code=${encodeURIComponent(value)}`,
        { maxRedirects: 0 },
      );
      assert.equal(callback.status(), 303);
      assert.equal(
        (await context.request.get(`${base}/auth/session`)).status(),
        200,
      );
    };
    const nav = (name: string) =>
      page
        .getByRole("navigation", { name: "Основная навигация" })
        .getByRole("link", { name, exact: true });
    await page.clock.install();
    // Native UI links and browser Back, not history injection or browser interception.
    for (const resource of ["customers", "catalog"] as const) {
      controls.reset();
      controls.actor("served-operator");
      await loginWithoutNavigation();
      const path =
        resource === "customers"
          ? "/app/customers?q=иван"
          : `/app/catalog?orderRef=${orderRef}&q=капучино`;
      const heading = resource === "customers" ? "Иван Петров" : "Капучино";
      const operation =
        resource === "customers" ? "searchCustomers" : "searchCatalogProducts";
      for (const status of [403, 503] as const) {
        controls.failures({});
        await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: heading }).waitFor();
        await press(nav("Новый заказ"));
        await page
          .getByRole("heading", { name: "Новый заказ", exact: true })
          .waitFor();
        if (status === 403) {
          controls.actor("served-operator", []);
          await loginWithoutNavigation();
        } else controls.failures({ [operation]: 503 });
        await page.clock.fastForward(31_000);
        const failed = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname ===
              (resource === "customers"
                ? "/api/client-v1/customers"
                : "/api/client-v1/catalog/products") && r.status() === status,
        );
        await page.goBack();
        await failed;
        if (status === 403) {
          await page.getByText("Недостаточно прав", { exact: true }).waitFor();
          assert.equal(
            await page.getByRole("heading", { name: heading }).count(),
            0,
          );
          if (resource === "customers") {
            assert.equal(await page.getByText("+799••••4567").count(), 0);
            assert.equal(
              await page.getByText(customerRef, { exact: true }).count(),
              0,
            );
            assert.equal(
              await page
                .getByRole("button", { name: "Выбрать", exact: true })
                .count(),
              0,
            );
          } else {
            assert.equal(
              await page
                .getByRole("button", { name: "Добавить", exact: true })
                .count(),
              0,
            );
            assert.equal(
              await page
                .getByRole("textbox", { name: "Количество для Капучино" })
                .count(),
              0,
            );
          }
          assert.equal(
            (await context.request.get(`${base}/auth/session`)).status(),
            200,
          );
          await passed(`${resource}-native-back-real-permission-403`);
          // A following 503 cannot resurrect the already denied cache.
          controls.actor("served-operator");
          await loginWithoutNavigation();
          await page.clock.fastForward(31_000);
          controls.failures({ [operation]: 503 });
          await press(nav("Новый заказ"));
          await page
            .getByRole("heading", { name: "Новый заказ", exact: true })
            .waitFor();
          const unavailable = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname.includes(
                resource === "customers" ? "/customers" : "/catalog/products",
              ) && r.status() === 503,
          );
          await page.goBack();
          await unavailable;
          assert.equal(
            await page.getByRole("heading", { name: heading }).count(),
            0,
          );
          if (resource === "customers") {
            assert.equal(await page.getByText("+799••••4567").count(), 0);
            assert.equal(
              await page.getByText(customerRef, { exact: true }).count(),
              0,
            );
            assert.equal(
              await page
                .getByRole("button", { name: "Выбрать", exact: true })
                .count(),
              0,
            );
          } else {
            assert.equal(
              await page
                .getByRole("button", { name: "Добавить", exact: true })
                .count(),
              0,
            );
            assert.equal(
              await page
                .getByRole("textbox", { name: "Количество для Капучино" })
                .count(),
              0,
            );
          }
          await passed(`${resource}-denial-then-503-no-resurrection`);
        } else {
          await page.clock.fastForward(600);
          await page
            .getByText("Сервис временно недоступен", { exact: true })
            .waitFor();
          await page.getByRole("heading", { name: heading }).waitFor();
          await passed(
            `${resource}-native-back-temporary-503-retains-authorized-cache`,
          );
        }
        controls.actor("served-operator");
        controls.failures({});
        await loginWithoutNavigation();
      }
    }
    controls.reset();
    await page.goto(`${base}/app/orders/${orderRef}`, {
      waitUntil: "networkidle",
    });
    controls.conflict();
    await page.getByRole("textbox", { name: "Количество Капучино" }).fill("3");
    await press(page.getByRole("button", { name: "Обновить", exact: true }));
    await page
      .getByRole("dialog", { name: "Заказ изменился на сервере" })
      .waitFor();
    const commandsBefore = controls
      .records()
      .filter((r) => r.operation === "upsertOrderItem").length;
    const readsBefore = controls
      .records()
      .filter((r) => r.operation === "getOrderCard").length;
    await press(
      page.getByRole("button", { name: "Обновить карточку", exact: true }),
    );
    await page
      .getByRole("dialog", { name: "Заказ изменился на сервере" })
      .waitFor({ state: "hidden" });
    assert.ok(
      controls.records().filter((r) => r.operation === "getOrderCard").length >
        readsBefore,
    );
    assert.equal(
      controls.records().filter((r) => r.operation === "upsertOrderItem")
        .length,
      commandsBefore,
    );
    await passed("conflict-explicit-owner-get-no-resubmit");
    for (const fatalStatus of [403, 404] as const) {
      controls.reset();
      await page.goto(`${base}/app/orders/${orderRef}`, {
        waitUntil: "networkidle",
      });
      controls.hold();
      await page
        .getByRole("textbox", { name: "Количество Капучино" })
        .fill("3");
      const before = controls
        .records()
        .filter((r) => r.operation === "upsertOrderItem").length;
      await press(page.getByRole("button", { name: "Обновить", exact: true }));
      await expect
        .poll(
          () =>
            controls.records().filter((r) => r.operation === "upsertOrderItem")
              .length,
        )
        .toBe(before + 1);
      await press(nav("Новый заказ"));
      await page
        .getByRole("heading", { name: "Новый заказ", exact: true })
        .waitFor();
      await page.clock.fastForward(31_000);
      controls.failures({ getOrderCard: fatalStatus });
      const denied = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/client-v1/orders/${orderRef}` &&
          r.status() === fatalStatus,
      );
      await page.goBack();
      await denied;
      await page
        .getByText(
          fatalStatus === 403 ? "Недостаточно прав" : "Заказ не найден",
          { exact: true },
        )
        .first()
        .waitFor();
      const lateResponse = page.waitForResponse(
        (r) => r.request().method() === "PUT" && r.status() === 200,
      );
      controls.release();
      await lateResponse;
      await page.clock.fastForward(500);
      assert.equal(
        await page.getByRole("heading", { name: "Иван Петров" }).count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Количество Капучино" })
          .count(),
        0,
      );
      await passed(
        `late-mutation-fatal-owner-get-${fatalStatus}-no-resurrection`,
      );
      for (const laterStatus of [503, 200] as const) {
        await press(nav("Новый заказ"));
        await page
          .getByRole("heading", { name: "Новый заказ", exact: true })
          .waitFor();
        if (laterStatus === 503) controls.failures({ getOrderCard: 503 });
        else controls.divergentProjection();
        await page.clock.fastForward(31_000);
        const laterRead = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `/api/client-v1/orders/${orderRef}` &&
            r.status() === laterStatus,
        );
        await page.goBack();
        await laterRead;
        if (laterStatus === 503) await page.clock.fastForward(600);
        assert.equal(
          await page.getByRole("heading", { name: "Иван Петров" }).count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("textbox", { name: "Количество Капучино" })
            .count(),
          0,
        );
        await passed(
          `fatal-${fatalStatus}-then-${laterStatus === 200 ? "equal-divergent-projection-200" : "503"}-no-resurrection`,
        );
      }
      await press(nav("Новый заказ"));
      await page
        .getByRole("heading", { name: "Новый заказ", exact: true })
        .waitFor();
      controls.olderProjection();
      await page.clock.fastForward(31_000);
      const olderRead = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/client-v1/orders/${orderRef}` &&
          r.status() === 200,
      );
      await page.goBack();
      const olderResponse = await olderRead;
      assert.equal((await olderResponse.json()).projectionVersion, "1");
      await page
        .getByText(
          fatalStatus === 403 ? "Недостаточно прав" : "Заказ не найден",
          { exact: true },
        )
        .first()
        .waitFor();
      assert.equal(
        await page.getByRole("heading", { name: "Иван Петров" }).count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Количество Капучино" })
          .count(),
        0,
      );
      assert.equal(
        controls.records().filter((r) => r.operation === "upsertOrderItem")
          .length,
        before + 1,
      );
      await passed(
        `fatal-${fatalStatus}-then-older-projection-200-no-resurrection`,
      );
      await press(nav("Новый заказ"));
      await page
        .getByRole("heading", { name: "Новый заказ", exact: true })
        .waitFor();
      controls.reset();
      await page.clock.fastForward(31_000);
      const acceptedRead = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/client-v1/orders/${orderRef}` &&
          r.status() === 200,
      );
      await page.goBack();
      assert.equal((await (await acceptedRead).json()).projectionVersion, "2");
      await page.getByRole("heading", { name: "Иван Петров" }).waitFor();
      await page
        .getByRole("textbox", { name: "Количество Капучино" })
        .waitFor();
      assert.equal(
        controls.records().filter((r) => r.operation === "upsertOrderItem")
          .length,
        before + 1,
      );
      await passed(
        `fatal-${fatalStatus}-then-accepted-equal-projection-200-restores-card`,
      );
    }
    controls.reset();
    await page.goto(`${base}/app/customers`, { waitUntil: "networkidle" });
    await press(page.getByRole("button", { name: "Новый клиент" }));
    await page
      .getByRole("dialog", { name: "Новый клиент" })
      .getByRole("textbox", { name: "Имя", exact: true })
      .fill("Old actor private draft");
    const mutationsBefore = controls
      .records()
      .filter((r) => r.method === "POST").length;
    controls.actor("served-operator-2");
    await loginWithoutNavigation();
    await page.clock.fastForward(31_000);
    await page.getByText("served-operator-2", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("dialog", { name: "Новый клиент" }).count(),
      0,
    );
    assert.equal(
      controls.records().filter((r) => r.method === "POST").length,
      mutationsBefore,
    );
    await passed("session-switch-fences-old-form-and-commands");
    await press(page.getByRole("button", { name: "Выйти", exact: true }));
    await press(
      page.getByRole("button", { name: "Завершить сессию", exact: true }),
    );
    await page.getByText("Требуется вход", { exact: true }).waitFor();
    assert.equal(
      (await context.request.get(`${base}/auth/session`)).status(),
      401,
    );
    await passed("real-logout-csrf-401-private-ui-hidden");
    await controls.expiry();
    await loginWithoutNavigation();
    await page.goto(`${base}/app/customers`, { waitUntil: "networkidle" });
    controls.expire();
    assert.equal(
      (await context.request.get(`${base}/auth/session`)).status(),
      401,
    );
    await page.reload();
    await page.getByText("Требуется вход", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "Клиенты", exact: true }).count(),
      0,
    );
    await passed(
      "authority-clock-absolute-expiry-native-401",
      "Distinct injectable authority now fixture; not wall-clock or live IdP expiry",
    );
  } finally {
    controls.release();
    await page.screenshot({
      path: resolve(evidence, "served-last-state.png"),
      fullPage: true,
    });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      resolve(evidence, "browser-network.json"),
      JSON.stringify(network, null, 2),
    );
    await page.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
