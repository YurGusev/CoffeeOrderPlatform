import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn.js";

export interface EmptyProps {
  action?: ReactNode;
  className?: string;
  description?: string;
  title: string;
}

export function Empty({
  action,
  className,
  description,
  title,
}: EmptyProps): ReactElement {
  return (
    <section
      aria-live="polite"
      className={cn(
        "rounded-panel border border-dashed border-border bg-surface p-8 text-center",
        className,
      )}
      role="status"
    >
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {description ? (
        <p className="mt-2 text-sm text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </section>
  );
}
