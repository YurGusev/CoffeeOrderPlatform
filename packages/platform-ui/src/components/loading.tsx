import type { ReactElement } from "react";
import { cn } from "../cn.js";

export interface LoadingProps {
  className?: string;
  label?: string;
}

export function Loading({
  className,
  label = "Загрузка",
}: LoadingProps): ReactElement {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "inline-flex min-h-10 items-center gap-2 text-sm text-muted",
        className,
      )}
      role="status"
    >
      <span
        aria-hidden="true"
        className="size-4 animate-pulse rounded-full bg-primary/60"
      />
      <span>{label}</span>
    </div>
  );
}
