import type { ReactElement } from "react";
import { Alert, Button } from "@coffee-platform/ui";
import { ApiError } from "./client.js";

export function problemFieldError(error: unknown, field: string): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.problem.errors.find((item) => item.field?.split("/").filter(Boolean).at(-1) === field)?.message;
}

export function ProblemAlert({ error, onRefresh }: Readonly<{ error: unknown; onRefresh?: () => void }>): ReactElement {
  const problem = error instanceof ApiError ? error.problem : undefined;
  const title = problem?.status === 403
    ? "Недостаточно прав"
    : problem?.status === 503
      ? "Сервис временно недоступен"
      : (problem?.title ?? "Операция не выполнена");
  const detail = problem?.status === 403
    ? "У текущего оператора нет доступа к этому разделу."
    : problem?.status === 503
      ? "Сервис не ответил. Введённые данные сохранены; повторите проверку позже."
      : (problem?.detail ?? (error instanceof Error ? error.message : "Неизвестная ошибка"));
  return (
    <Alert title={title} tone="danger">
      <p>{detail}</p>
      {problem?.errors.map((item, index) => <p className="problem-field" key={`${item.code}-${index}`}>{item.field ? `${item.field}: ` : ""}{item.message}</p>)}
      {onRefresh ? <Button onPress={onRefresh} variant="secondary">Обновить данные</Button> : null}
    </Alert>
  );
}
