import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Alert, Button } from "@coffee-platform/ui";
import type { CustomerResponse } from "@coffee-platform/generated-client-v1";
import { useNavigate } from "react-router-dom";
import {
  PENDING_INTENTS_CHANGED,
  readPendingIntents,
} from "../api/idempotency.js";
import { ProblemAlert } from "../api/problem.js";
import { useReplayIntent } from "../api/remote.js";
import { useSession } from "./session.js";

function isCustomer(value: unknown): value is CustomerResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "customerRef" in value &&
    "displayName" in value &&
    !("orderRef" in value)
  );
}

export function PendingRecovery(): ReactElement | null {
  const session = useSession();
  const navigate = useNavigate();
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<string>();
  const [verificationError, setVerificationError] = useState<unknown>();
  const snapshot = useMemo(() => readPendingIntents(), [revision]);
  const visible = snapshot.items.filter(
    (item) => item.actorRef === session.actorRef,
  );
  const blocked = snapshot.items.filter(
    (item) => item.actorRef !== session.actorRef,
  );
  const replay = useReplayIntent(session.actorRef);
  useEffect(() => {
    const refresh = (): void => setRevision((value) => value + 1);
    window.addEventListener(PENDING_INTENTS_CHANGED, refresh);
    return () => window.removeEventListener(PENDING_INTENTS_CHANGED, refresh);
  }, []);

  if (
    !snapshot.corrupt &&
    visible.length === 0 &&
    blocked.length === 0 &&
    !message &&
    !verificationError &&
    !replay.isError
  )
    return null;
  return (
    <section aria-label="Восстановление команд" className="recovery-panel">
      {snapshot.corrupt ? (
        <Alert title="Данные восстановления недоступны" tone="danger">
          Повреждённая запись не используется как команда или URL.
        </Alert>
      ) : null}
      {blocked.length > 0 ? (
        <Alert title="Есть команды другой сессии" tone="warning">
          Они заблокированы и не будут отправлены от имени текущего оператора.
        </Alert>
      ) : null}
      {visible.map((intent) => (
        <div className="recovery-item" key={intent.key}>
          <div>
            <strong>Исход команды неизвестен</strong>
            <span>
              {intent.kind} · {intent.createdAt}
            </span>
          </div>
          <Button
            isDisabled={replay.isPending}
            onPress={() =>
              replay.mutate(intent, {
                onSuccess: (outcome) => {
                  setRevision((value) => value + 1);
                  setVerificationError(outcome.verificationError);
                  if (outcome.orderRef) {
                    void navigate(`/app/orders/${outcome.orderRef}`);
                    setMessage(
                      outcome.verificationError
                        ? "Результат команды найден, но текущее состояние заказа проверить не удалось."
                        : "Результат команды найден, текущее состояние заказа обновлено.",
                    );
                  } else if (isCustomer(outcome.result)) {
                    void navigate(
                      `/app/orders/new?customerRef=${encodeURIComponent(outcome.result.customerRef)}`,
                    );
                  } else {
                    setMessage(
                      "Результат команды подтверждён сервером. Продолжите сценарий из текущего экрана.",
                    );
                  }
                },
              })
            }
            size="compact"
            variant="secondary"
          >
            Проверить результат команды
          </Button>
        </div>
      ))}
      {replay.isError ? <ProblemAlert error={replay.error} /> : null}
      {verificationError ? (
        <>
          <Alert
            title="Результат найден, но текущая карточка недоступна"
            tone="warning"
          >
            Исторический ответ не показывается как подтверждённое текущее
            состояние.
          </Alert>
          <ProblemAlert error={verificationError} />
        </>
      ) : null}
      {message ? (
        <Alert title="Результат найден" tone="success">
          {message}
        </Alert>
      ) : null}
    </section>
  );
}
