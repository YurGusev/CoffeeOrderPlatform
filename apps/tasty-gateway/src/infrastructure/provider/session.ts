import type {
  TastyCredentials,
  TastyHttpClient,
  TastyReadOperation,
} from "./http-client.js";

export type TastySessionTransport = Pick<
  TastyHttpClient,
  "timeoutMs" | "read" | "login"
>;

type Session = Readonly<{
  token: string;
  startedAt: number;
  expiresIn: number;
}>;
type ErrorCode =
  | "TASTY_SESSION_FAILED"
  | "TASTY_SESSION_BLOCKED"
  | "TASTY_SESSION_LOGIN_INVALID"
  | "TASTY_SESSION_CANCELLED"
  | "TASTY_SESSION_TIMEOUT"
  | "TASTY_SESSION_UNAUTHORIZED"
  | "TASTY_SESSION_INVALID_INPUT";

export class TastySessionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.name = "TastySessionError";
    this.code = code;
  }
}

function loginData(body: string, startedAt: number): Session {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TastySessionError("TASTY_SESSION_LOGIN_INVALID");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TastySessionError("TASTY_SESSION_LOGIN_INVALID");
  const data: unknown = (parsed as Record<string, unknown>)["data"];
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new TastySessionError("TASTY_SESSION_LOGIN_INVALID");
  const fields = data as Record<string, unknown>;
  const token = fields["access_token"];
  const expiresIn = fields["expires_in"];
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    !token.isWellFormed() ||
    /\s/u.test(token) ||
    token.split("").some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    }) ||
    (fields["token_type"] !== "bearer" && fields["token_type"] !== "Bearer") ||
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new TastySessionError("TASTY_SESSION_LOGIN_INVALID");
  }
  return { token, startedAt, expiresIn };
}

function valid(session: Session): boolean {
  return (performance.now() - session.startedAt) / 1000 < session.expiresIn;
}

function waitFor(
  flight: Promise<Session>,
  signal: AbortSignal,
): Promise<Session> {
  if (signal.aborted)
    return Promise.reject(new TastySessionError("TASTY_SESSION_CANCELLED"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new TastySessionError("TASTY_SESSION_CANCELLED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void flight.then(
      (session) => {
        signal.removeEventListener("abort", abort);
        resolve(session);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class TastyProviderSession {
  readonly #transport: TastySessionTransport;
  readonly #timeoutMs: number;
  readonly #loadCredentials: (signal: AbortSignal) => Promise<TastyCredentials>;
  #session: Session | undefined;
  #flight: Promise<Session> | undefined;
  #blocked = false;

  constructor(
    transport: TastySessionTransport,
    loadCredentials: (signal: AbortSignal) => Promise<TastyCredentials>,
  ) {
    if (
      !Number.isSafeInteger(transport.timeoutMs) ||
      transport.timeoutMs <= 0 ||
      transport.timeoutMs > 2_147_483_647
    )
      throw new TastySessionError("TASTY_SESSION_FAILED");
    this.#transport = transport;
    this.#timeoutMs = transport.timeoutMs;
    this.#loadCredentials = loadCredentials;
  }

  async read(
    operation: TastyReadOperation,
    signal: AbortSignal,
  ): Promise<string> {
    if (
      (operation !== "catalog" && operation !== "cart") ||
      !(signal instanceof AbortSignal)
    )
      throw new TastySessionError("TASTY_SESSION_INVALID_INPUT");
    if (signal.aborted) throw new TastySessionError("TASTY_SESSION_CANCELLED");
    if (this.#blocked) throw new TastySessionError("TASTY_SESSION_BLOCKED");
    let session = this.#session;
    if (session === undefined || !valid(session)) {
      this.#session = undefined;
      session = await waitFor(this.#flight ?? this.#startFlight(), signal);
    }
    if (signal.aborted) throw new TastySessionError("TASTY_SESSION_CANCELLED");
    if (this.#blocked) throw new TastySessionError("TASTY_SESSION_BLOCKED");
    if (!valid(session)) throw new TastySessionError("TASTY_SESSION_FAILED");
    try {
      return await this.#transport.read(operation, session.token, signal);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "TASTY_HTTP_REJECTED" &&
        "status" in error &&
        error.status === 401
      ) {
        if (this.#session === session) {
          this.#session = undefined;
          this.#blocked = true;
        }
        throw new TastySessionError("TASTY_SESSION_UNAUTHORIZED");
      }
      throw new TastySessionError(
        signal.aborted ? "TASTY_SESSION_CANCELLED" : "TASTY_SESSION_FAILED",
      );
    }
  }

  #startFlight(): Promise<Session> {
    const flight = this.#login();
    this.#flight = flight;
    void flight.then(
      () => {
        if (this.#flight === flight) this.#flight = undefined;
      },
      () => {
        if (this.#flight === flight) this.#flight = undefined;
      },
    );
    return flight;
  }

  async #login(): Promise<Session> {
    const controller = new AbortController();
    const deadline = performance.now() + this.#timeoutMs;
    const checkDeadline = () => {
      if (controller.signal.aborted || performance.now() >= deadline) {
        controller.abort();
        throw new TastySessionError("TASTY_SESSION_TIMEOUT");
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TastySessionError("TASTY_SESSION_TIMEOUT"));
      }, this.#timeoutMs);
    });
    try {
      const acquire = async (): Promise<Session> => {
        const credentials = await this.#loadCredentials(controller.signal);
        checkDeadline();
        const startedAt = performance.now();
        const body = await this.#transport.login(
          credentials,
          controller.signal,
        );
        checkDeadline();
        const session = loginData(body, startedAt);
        checkDeadline();
        return session;
      };
      const session = await Promise.race([acquire(), timeout]);
      checkDeadline();
      if (!valid(session))
        throw new TastySessionError("TASTY_SESSION_LOGIN_INVALID");
      checkDeadline();
      this.#session = session;
      return session;
    } catch (error) {
      if (performance.now() >= deadline) controller.abort();
      this.#session = undefined;
      this.#blocked = true;
      const code = controller.signal.aborted
        ? "TASTY_SESSION_TIMEOUT"
        : error instanceof TastySessionError &&
            error.code === "TASTY_SESSION_LOGIN_INVALID"
          ? error.code
          : "TASTY_SESSION_FAILED";
      throw new TastySessionError(code);
    } finally {
      clearTimeout(timer);
    }
  }
}
