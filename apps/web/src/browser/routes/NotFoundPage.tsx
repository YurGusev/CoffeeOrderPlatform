import type { ReactElement } from "react";
import { Link } from "@coffee-platform/ui";
import { PageHeader } from "../app/PageHeader.js";

export function NotFoundPage(): ReactElement {
  return (
    <main className="boot-state">
      <div className="boot-card">
        <PageHeader description="Проверьте адрес deep link." eyebrow="404">
          Маршрут не найден
        </PageHeader>
        <Link href="/app/customers">К клиентам</Link>
      </div>
    </main>
  );
}
