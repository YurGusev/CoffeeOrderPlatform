export type TastyReadOperation = "catalog" | "cart";

export type TastyCredentials = Readonly<{
  login: string;
  password: string;
  device: Readonly<{
    device_name: string;
    device_os: string;
    device_browser: string;
    device_timezone: string;
  }>;
}>;

type ErrorCode =
  | "TASTY_HTTP_REJECTED"
  | "TASTY_HTTP_REDIRECT"
  | "TASTY_HTTP_TIMEOUT"
  | "TASTY_HTTP_CANCELLED"
  | "TASTY_HTTP_TRANSPORT"
  | "TASTY_HTTP_TOO_LARGE"
  | "TASTY_HTTP_INVALID_JSON"
  | "TASTY_HTTP_INVALID_INPUT";

export class TastyHttpError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;

  constructor(code: ErrorCode, status?: number) {
    super(code);
    this.name = "TastyHttpError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function invalid(): never {
  throw new TastyHttpError("TASTY_HTTP_INVALID_INPUT");
}

function validText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed())
    return false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function cancel(body: ReadableStream<Uint8Array> | null): void {
  if (body !== null) void body.cancel().catch(() => undefined);
}

export class TastyHttpClient {
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(
    options: Readonly<{ timeoutMs: number; maxResponseBytes: number }>,
  ) {
    if (
      options === null ||
      typeof options !== "object" ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes <= 0
    )
      invalid();
    this.#timeoutMs = options.timeoutMs;
    this.#maxResponseBytes = options.maxResponseBytes;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  async read(
    operation: TastyReadOperation,
    token: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (
      (operation !== "catalog" && operation !== "cart") ||
      !validText(token) ||
      /\s/u.test(token) ||
      !(signal instanceof AbortSignal)
    )
      invalid();
    return this.#request(
      operation === "catalog"
        ? "/api/v1/catalog/products"
        : "/api/v1/catalog/cart",
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
      },
      signal,
    );
  }

  async login(
    credentials: TastyCredentials,
    signal: AbortSignal,
  ): Promise<string> {
    let body: string;
    try {
      if (
        credentials === null ||
        typeof credentials !== "object" ||
        credentials.device === null ||
        typeof credentials.device !== "object" ||
        !(signal instanceof AbortSignal)
      )
        invalid();
      const { login, password, device } = credentials;
      const { device_name, device_os, device_browser, device_timezone } =
        device;
      if (
        ![
          login,
          password,
          device_name,
          device_os,
          device_browser,
          device_timezone,
        ].every(validText)
      )
        invalid();
      body = JSON.stringify({
        login,
        password,
        device: { device_name, device_os, device_browser, device_timezone },
      });
    } catch {
      return invalid();
    }
    return this.#request(
      "/api/v1/auth/login",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body,
      },
      signal,
    );
  }

  async #request(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw new TastyHttpError("TASTY_HTTP_CANCELLED");
    const deadline = performance.now() + this.#timeoutMs;
    const controller = new AbortController();
    let interruption: "TASTY_HTTP_CANCELLED" | "TASTY_HTTP_TIMEOUT" | undefined;
    const stop = (code: "TASTY_HTTP_CANCELLED" | "TASTY_HTTP_TIMEOUT") => {
      if (interruption === undefined) {
        interruption = code;
        controller.abort();
      }
    };
    const checkDeadline = () => {
      if (interruption === undefined && performance.now() >= deadline)
        stop("TASTY_HTTP_TIMEOUT");
      if (interruption !== undefined) throw new TastyHttpError(interruption);
    };
    const onAbort = () => stop("TASTY_HTTP_CANCELLED");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("TASTY_HTTP_TIMEOUT"), this.#timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    try {
      checkDeadline();
      response = await fetch(`https://api.tastycoffee.ru${path}`, {
        ...init,
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
      });
      checkDeadline();
      if (response.status >= 300 && response.status < 400) {
        throw new TastyHttpError("TASTY_HTTP_REDIRECT");
      }
      if (!response.ok) {
        throw new TastyHttpError("TASTY_HTTP_REJECTED", response.status);
      }
      const contentType = response.headers.get("content-type");
      if (
        contentType === null ||
        !/^application\/json(?:\s*;|\s*$)/iu.test(contentType)
      ) {
        throw new TastyHttpError("TASTY_HTTP_INVALID_JSON");
      }
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d+$/u.test(length) ||
          BigInt(length) > BigInt(this.#maxResponseBytes))
      ) {
        throw new TastyHttpError("TASTY_HTTP_TOO_LARGE");
      }
      if (response.body === null)
        throw new TastyHttpError("TASTY_HTTP_INVALID_JSON");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "";
      let size = 0;
      while (true) {
        checkDeadline();
        const chunk = await reader.read();
        checkDeadline();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.#maxResponseBytes)
          throw new TastyHttpError("TASTY_HTTP_TOO_LARGE");
        try {
          text += decoder.decode(chunk.value, { stream: true });
        } catch {
          throw new TastyHttpError("TASTY_HTTP_INVALID_JSON");
        }
      }
      try {
        text += decoder.decode();
        JSON.parse(text);
      } catch {
        throw new TastyHttpError("TASTY_HTTP_INVALID_JSON");
      }
      checkDeadline();
      return text;
    } catch (error) {
      checkDeadline();
      if (error instanceof TastyHttpError) throw error;
      throw new TastyHttpError("TASTY_HTTP_TRANSPORT");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (reader !== undefined) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      } else if (response !== undefined) cancel(response.body);
      controller.abort();
    }
  }
}
