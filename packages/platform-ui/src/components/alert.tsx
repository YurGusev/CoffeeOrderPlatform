import type { ReactElement, ReactNode } from "react";
import { cn } from "../cn.js";

export type AlertTone = "info" | "success" | "warning" | "danger";

export interface AlertProps {
  children: ReactNode;
  className?: string;
  title?: string;
  tone?: AlertTone;
}

const toneClasses: Record<AlertTone, string> = {
  danger: "border-danger-border bg-danger-bg text-danger-text",
  info: "border-primary/30 bg-primary/10 text-primary",
  success: "border-success-border bg-success-bg text-success-text",
  warning: "border-warning-border bg-warning-bg text-warning-text",
};

export function Alert({ children, className, title, tone = "info" }: AlertProps): ReactElement {
  const role = tone === "danger" ? "alert" : "status";
  const live = tone === "danger" ? "assertive" : "polite";

  return (
    <div aria-live={live} className={cn("rounded-control border p-4 text-sm", toneClasses[tone], className)} role={role}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      <div>{children}</div>
    </div>
  );
}
