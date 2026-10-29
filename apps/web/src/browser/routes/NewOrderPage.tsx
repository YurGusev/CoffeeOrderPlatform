import type { ReactElement } from "react";
import { Alert, Button, Link } from "@coffee-platform/ui";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ProblemAlert } from "../api/problem.js";
import { useCreateDraft } from "../api/remote.js";
import { PageHeader } from "../app/PageHeader.js";
import { useSession } from "../app/session.js";

export function NewOrderPage(): ReactElement {
  const session = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const customerRef = params.get("customerRef") ?? "";
  const validCustomerRef = /^cus_[0-9A-HJKMNP-TV-Z]{26}$/u.test(customerRef);
  const createDraft = useCreateDraft(session.actorRef);
  return (
    <>
      <PageHeader
        description="Черновик создаётся отдельной защищённой командой. До неё заказ не существует."
        eyebrow="ШАГ 2 · ЧЕРНОВИК"
      >
        Новый заказ
      </PageHeader>
      <section className="surface narrow-surface">
        {!validCustomerRef ? (
          <Alert title="Сначала выберите клиента" tone="warning">
            В адресе отсутствует корректный идентификатор клиента. Вернитесь в{" "}
            <Link href="/app/customers">поиск клиентов</Link>.
          </Alert>
        ) : (
          <>
            <div className="selection-card">
              <span>Выбранный клиент</span>
              <strong>{customerRef}</strong>
              <small>Клиента повторно проверит сервис Customer.</small>
            </div>
            <p>
              После создания откроется карточка заказа. Товары и цены
              добавляются уже в неё.
            </p>
            <Button
              isPending={createDraft.isPending}
              onPress={() =>
                createDraft.mutate(customerRef, {
                  onSuccess: (order) =>
                    void navigate(`/app/orders/${order.orderRef}`, {
                      replace: true,
                    }),
                })
              }
            >
              Создать черновик
            </Button>
            {createDraft.isError ? (
              <ProblemAlert error={createDraft.error} />
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
