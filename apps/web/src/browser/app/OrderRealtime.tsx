import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Alert, Badge, Button } from "@coffee-platform/ui";
import { queryClient } from "./query-client.js";
import { SESSION_INVALIDATED } from "../api/client.js";
import {
  assertApplicationSession,
  captureApplicationSession,
} from "../api/session-identity.js";
import {
  invalidateExistingOrderDetails,
  invalidateOrderHint,
  parseOrderStreamData,
  type OrderStreamEvent,
} from "../../realtime/order-invalidations.js";

type Connection = Readonly<{
  status: "Подключено" | "Переподключение" | "Обновление состояния";
  disconnected: boolean;
  refresh: () => void;
}>;
const ConnectionContext = createContext<Connection | undefined>(undefined);

/** Mounted once, inside the authorized, keyed application-session boundary. */
export function OrderRealtime({
  children,
  actorRef,
}: {
  children: ReactNode;
  actorRef: string;
}): ReactElement {
  const [status, setStatus] = useState<Connection["status"]>("Переподключение");
  const [disconnected, setDisconnected] = useState(false);
  const [refresh, setRefresh] = useState<() => void>(() => () => undefined);
  useEffect(() => {
    const session = captureApplicationSession(actorRef);
    const source = new EventSource("/events");
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshRevision = 0;
    const isCurrent = (): boolean => {
      if (closed) return false;
      try {
        assertApplicationSession(session);
        return true;
      } catch {
        return false;
      }
    };
    const stopTimer = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };
    const startTimer = (): void => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        if (isCurrent()) setDisconnected(true);
      }, 30_000);
    };
    const connected = (): void => {
      if (!isCurrent()) return;
      stopTimer();
      setDisconnected(false);
      setStatus("Подключено");
    };
    const failed = (): void => {
      if (!isCurrent()) return;
      refreshRevision += 1;
      setStatus("Переподключение");
      startTimer();
      // Native EventSource alone owns reconnect/backoff. Its error does not
      // reveal HTTP status; session authority/401 handling remains in #9.
    };
    const refreshOwner = async (work: () => Promise<void>): Promise<void> => {
      if (!isCurrent()) return;
      const revision = ++refreshRevision;
      setStatus("Обновление состояния");
      try {
        await work();
      } finally {
        if (isCurrent() && revision === refreshRevision) {
          setStatus(
            source.readyState === EventSource.OPEN
              ? "Подключено"
              : "Переподключение",
          );
        }
      }
    };
    const listeners = (
      ["resource-invalidated.v1", "stream-ready.v1", "stream-reset.v1"] as const
    ).map((name: OrderStreamEvent) => {
      const listener = (event: Event): void => {
        if (
          !isCurrent() ||
          !(event instanceof MessageEvent) ||
          typeof event.data !== "string"
        )
          return;
        const value = parseOrderStreamData(name, event.data);
        if (!value) return;
        if (name === "stream-ready.v1") connected();
        void refreshOwner(() =>
          "subjectRef" in value
            ? invalidateOrderHint(queryClient, value, isCurrent)
            : invalidateExistingOrderDetails(queryClient, isCurrent),
        );
      };
      source.addEventListener(name, listener);
      return { name, listener };
    });
    const close = (): void => {
      if (closed) return;
      closed = true;
      stopTimer();
      source.removeEventListener("open", connected);
      source.removeEventListener("error", failed);
      for (const { name, listener } of listeners)
        source.removeEventListener(name, listener);
      window.removeEventListener(SESSION_INVALIDATED, close);
      source.close();
    };
    source.addEventListener("open", connected);
    source.addEventListener("error", failed);
    window.addEventListener(SESSION_INVALIDATED, close);
    setRefresh(() => () => {
      void refreshOwner(() =>
        invalidateExistingOrderDetails(queryClient, isCurrent),
      );
    });
    startTimer();
    return close;
  }, [actorRef]);
  return (
    <ConnectionContext.Provider value={{ status, disconnected, refresh }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function RealtimeIndicator(): ReactElement | null {
  const connection = useContext(ConnectionContext);
  return connection ? (
    <span aria-label="Соединение обновлений" role="status">
      <Badge tone={connection.status === "Подключено" ? "success" : "warning"}>
        {connection.status}
      </Badge>
    </span>
  ) : null;
}

export function RealtimeFallback(): ReactElement | null {
  const connection = useContext(ConnectionContext);
  return connection?.disconnected ? (
    <Alert title="Автоматические обновления недоступны" tone="warning">
      <p>
        Соединение прервано. Статус соединения не подтверждает состояние заказа.
        Проверьте данные у владельца вручную.
      </p>
      <Button onPress={connection.refresh} size="compact" variant="quiet">
        Проверить данные заказов
      </Button>
    </Alert>
  ) : null;
}
