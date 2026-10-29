import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

export function PageHeader({
  children,
  description,
  eyebrow,
}: Readonly<{
  children: ReactNode;
  description: string;
  eyebrow: string;
}>): ReactElement {
  const location = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [location.pathname]);
  return (
    <header className="page-header">
      <p className="eyebrow">{eyebrow}</p>
      <h1 ref={heading} tabIndex={-1}>
        {children}
      </h1>
      <p className="page-description">{description}</p>
    </header>
  );
}
