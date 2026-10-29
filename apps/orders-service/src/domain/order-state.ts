export type FirstLaunchOrderCommand =
  | "CreateDraft"
  | "UpsertItem"
  | "DeleteItem"
  | "Confirm"
  | "RequestReconciliation";
export type FirstLaunchOrderStatus = "Draft" | "Confirmed";

/** A rejected transition is represented by null; callers choose the command-specific typed error. */
export function nextOrderStatus(
  status: string | null,
  command: FirstLaunchOrderCommand,
): FirstLaunchOrderStatus | null {
  switch (command) {
    case "CreateDraft":
      return status === null ? "Draft" : null;
    case "UpsertItem":
    case "DeleteItem":
      return status === "Draft" ? "Draft" : null;
    case "Confirm":
      return status === "Draft" ? "Confirmed" : null;
    case "RequestReconciliation":
      return status === "Confirmed" ? "Confirmed" : null;
    default: {
      const impossible: never = command;
      return impossible;
    }
  }
}
