import type { ReactElement } from "react";

export type IconName = "add" | "close" | "refresh" | "search" | "warning" | "chevron";

export interface IconProps {
  name: IconName;
  label?: string;
  size?: number;
}

export function Icon({ name, label, size = 20 }: IconProps): ReactElement {
  const common = {
    fill: "none",
    height: size,
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 24 24",
    width: size,
  };

  const paths: Record<IconName, ReactElement> = {
    add: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    close: (
      <>
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </>
    ),
    refresh: <path d="M20 11a8 8 0 0 0-14.8-3L3 11m0 0V5m0 6h6m-5 2a8 8 0 0 0 14.8 3L21 13m0 0v6m0-6h-6" />,
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    warning: (
      <>
        <path d="m12 4 9 16H3L12 4Z" />
        <path d="M12 9v5" />
        <path d="M12 17h.01" />
      </>
    ),
    chevron: <path d="m9 6 6 6-6 6" />,
  };

  return (
    <svg
      {...common}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    >
      {paths[name]}
    </svg>
  );
}
