import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { BrowserSession } from "@coffee-platform/generated-edge-auth-v1";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Link, Loading } from "@coffee-platform/ui";
import { useNavigate } from "react-router-dom";
import { ApiError, SESSION_INVALIDATED } from "../api/client.js";
import { useBrowserSession } from "../api/remote.js";
import { setApplicationSession } from "../api/session-identity.js";
import {
  currentEpochMilliseconds,
  instantEpochMilliseconds,
} from "../api/time.js";

import { OrderRealtime } from "./OrderRealtime.js";
const SessionContext = createContext<BrowserSession | undefined>(undefined);

export function useSession(): BrowserSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("SessionBoundary отсутствует");
  return session;
}

export function SessionBoundary({
  children,
}: Readonly<{ children: ReactNode }>): ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [invalidated, setInvalidated] = useState(false);
  const previousActorRef = useRef<string | undefined>(undefined);
  const session = useBrowserSession();

  useEffect(() => {
    const invalidate = (): void => {
      setInvalidated(true);
      setApplicationSession(undefined);
      void queryClient.cancelQueries();
      queryClient.getMutationCache().clear();
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== "browser-session",
      });
      void session.refetch();
    };
    window.addEventListener(SESSION_INVALIDATED, invalidate);
    return () => window.removeEventListener(SESSION_INVALIDATED, invalidate);
  }, [queryClient, session.refetch]);

  useEffect(() => {
    if (session.isError) {
      setApplicationSession(undefined);
      void queryClient.cancelQueries();
      queryClient.getMutationCache().clear();
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== "browser-session",
      });
      return;
    }
    if (session.data && !session.isFetching) setInvalidated(false);
  }, [queryClient, session.data, session.isError, session.isFetching]);

  useEffect(() => {
    if (!session.data) return;
    // Browser timeout is signed 32-bit; a long-lived session must not overflow
    // into an immediate invalidation and destroy/recreate the native stream.
    let timer: number | undefined;
    const checkExpiry = (): void => {
      const remaining =
        instantEpochMilliseconds(session.data.expiresAt) -
        currentEpochMilliseconds();
      if (remaining <= 0) {
        window.dispatchEvent(new Event(SESSION_INVALIDATED));
        return;
      }
      timer = window.setTimeout(
        checkExpiry,
        Math.min(remaining, 2_147_483_647),
      );
    };
    checkExpiry();
    return () => window.clearTimeout(timer);
  }, [session.data]);

  useEffect(() => {
    if (!session.data) return;
    if (
      previousActorRef.current &&
      previousActorRef.current !== session.data.actorRef
    )
      void navigate("/app/customers", { replace: true });
    previousActorRef.current = session.data.actorRef;
  }, [navigate, session.data]);

  if (session.isPending)
    return (
      <main className="boot-state">
        <Loading label="Проверяем сессию оператора" />
      </main>
    );
  if (invalidated || session.isError) {
    const currentPath = `${window.location.pathname}${window.location.search}`;
    const returnTo = window.location.pathname.startsWith("/app/")
      ? currentPath
      : "/app/customers";
    const sessionUnavailable =
      session.error instanceof ApiError && session.error.problem.status >= 500;
    return (
      <main className="boot-state">
        <div className="boot-card">
          <Alert
            title={
              sessionUnavailable
                ? "Не удалось проверить сессию"
                : "Требуется вход"
            }
            tone="warning"
          >
            {sessionUnavailable
              ? "Приватные данные и команды скрыты, пока сервер авторизации недоступен."
              : "Приватные данные и команды скрыты до подтверждения серверной сессии."}
          </Alert>
          {sessionUnavailable ? (
            <Button onPress={() => void session.refetch()} variant="secondary">
              Повторить проверку
            </Button>
          ) : (
            <Link href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
              Войти через защищённый контур
            </Link>
          )}
        </div>
      </main>
    );
  }

  return (
    <SessionContext value={session.data}>
      <OrderRealtime
        actorRef={session.data.actorRef}
        key={session.data.actorRef}
      >
        {children}
      </OrderRealtime>
    </SessionContext>
  );
}
