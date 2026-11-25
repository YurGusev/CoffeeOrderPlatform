import {
  isCustomerOrderInput,
  isCustomerProblem,
  isCustomerRef,
  type CustomerOrderInput,
} from "@coffee-platform/contracts-customer-v1";
import { observe } from "../telemetry/index.js";

type HttpClient = Readonly<{
  fetch: (path: string, options?: RequestInit) => Promise<Response>;
}>;
type CustomerOrderInputRequest = Readonly<{
  customerRef: string;
  delegation: string;
  correlationId: string;
  traceparent?: string;
  signal: AbortSignal;
}>;
export type CustomerOrderInputClientErrorCode =
  "CUSTOMER_NOT_FOUND" | "CUSTOMER_NOT_ACTIVE" | "CUSTOMER_UNAVAILABLE";

export class CustomerOrderInputClientError extends Error {
  public readonly code: CustomerOrderInputClientErrorCode;

  public constructor(code: CustomerOrderInputClientErrorCode) {
    super(code);
    this.name = "CustomerOrderInputClientError";
    this.code = code;
  }
}

const MAX_BODY_BYTES = 256 * 1024;
const DEADLINE_MS = 1_000;

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function mediaType(response: Response): string | undefined {
  return response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
}

async function readJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.body === null) throw new Error("empty response body");
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  ) {
    await response.body.cancel();
    throw new Error("invalid response length");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("response body exceeds limit");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      await reader.cancel();
    } catch {
      /* response may already be consumed or aborted */
    }
    reader.releaseLock();
  }
}

function unavailableUnlessCallerCancelled(
  error: unknown,
  request: CustomerOrderInputRequest,
): never {
  if (request.signal.aborted) throw request.signal.reason ?? error;
  throw new CustomerOrderInputClientError("CUSTOMER_UNAVAILABLE");
}

export function createCustomerOrderInputClient(client: HttpClient): Readonly<{
  getOrderInput: (
    request: CustomerOrderInputRequest,
  ) => Promise<CustomerOrderInput>;
}> {
  return {
    getOrderInput(request) {
      return observe(
        "orders.customer.order_input",
        async () => {
          if (!isCustomerRef(request.customerRef))
            throw new CustomerOrderInputClientError("CUSTOMER_UNAVAILABLE");
          request.signal.throwIfAborted();
          const signal = AbortSignal.any([
            request.signal,
            AbortSignal.timeout(DEADLINE_MS),
          ]);
          let response: Response;
          try {
            response = await client.fetch(
              `/api/internal-v1/customers/${encodeURIComponent(request.customerRef)}/order-input`,
              {
                method: "GET",
                headers: {
                  accept: "application/json, application/problem+json",
                  "x-service-delegation": request.delegation,
                  "x-correlation-id": request.correlationId,
                  ...(request.traceparent === undefined
                    ? {}
                    : { traceparent: request.traceparent }),
                },
                signal,
                redirect: "error",
              },
            );
          } catch (error) {
            return unavailableUnlessCallerCancelled(error, request);
          }
          if (request.signal.aborted) throw request.signal.reason;
          if (signal.aborted)
            throw new CustomerOrderInputClientError("CUSTOMER_UNAVAILABLE");

          if (response.status === 200) {
            if (mediaType(response) !== "application/json") {
              cancelBody(response);
              throw new CustomerOrderInputClientError("CUSTOMER_UNAVAILABLE");
            }
            let body: unknown;
            try {
              body = await readJson(response, signal);
            } catch (error) {
              return unavailableUnlessCallerCancelled(error, request);
            }
            if (
              !isCustomerOrderInput(body) ||
              body.customerRef !== request.customerRef
            )
              throw new CustomerOrderInputClientError("CUSTOMER_UNAVAILABLE");
            if (body.state !== "Active")
              throw new CustomerOrderInputClientError("CUSTOMER_NOT_ACTIVE");
            return body;
          }

          const expectedCodes: Readonly<Record<number, string>> = {
            400: "VALIDATION_FAILED",
            401: "SERVICE_AUTHENTICATION_REQUIRED",
            403: "SERVICE_DELEGATION_INVALID",
            404: "CUSTOMER_NOT_FOUND",
            500: "INTERNAL_ERROR",
            503: "CUSTOMER_UNAVAILABLE",
          };
          const expectedCode = expectedCodes[response.status];
          if (
            expectedCode === undefined ||
            mediaType(response) !== "application/problem+json"
          ) {
            cancelBody(response);
            throw new CustomerOrderInputClientError("CUSTOMER_UNAVAILABLE");
          }
          let body: unknown;
          try {
            body = await readJson(response, signal);
          } catch (error) {
            return unavailableUnlessCallerCancelled(error, request);
          }
          if (
            !isCustomerProblem(body) ||
            body.status !== response.status ||
            body.code !== expectedCode
          ) {
            throw new CustomerOrderInputClientError("CUSTOMER_UNAVAILABLE");
          }
          if (response.status === 404)
            throw new CustomerOrderInputClientError("CUSTOMER_NOT_FOUND");
          throw new CustomerOrderInputClientError("CUSTOMER_UNAVAILABLE");
        },
        request.signal,
      );
    },
  };
}
