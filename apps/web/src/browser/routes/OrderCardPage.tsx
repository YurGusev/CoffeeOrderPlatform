import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Dialog, Empty, Field, Link, Loading } from "@coffee-platform/ui";
import type { CatalogProductSummary, OrderCardResponse, OrderItem } from "@coffee-platform/generated-client-v1";
import { useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client.js";
import { isFatalOrderCardReadError } from "../api/order-card.js";
import { compareDecimalVersion, formatMoney } from "../api/format.js";
import { ProblemAlert, problemFieldError } from "../api/problem.js";
import { useConfirmOrder, useDeleteOrderItem, useOrderCard, useQuoteAndPutItem, useRequestReconciliation } from "../api/remote.js";
import { PageHeader } from "../app/PageHeader.js";
import { queryKeys } from "../app/query-keys.js";
import { useSession } from "../app/session.js";

function toneForAroma(state: OrderCardResponse["aroma"]["state"]): "danger" | "info" | "neutral" | "success" | "warning" {
  if (state === "InSync") return "success";
  if (state === "Blocked" || state === "UnknownOutcome") return "danger";
  if (state === "Converging" || state === "PendingObservation") return "info";
  return state === "OutOfSync" ? "warning" : "neutral";
}

const aromaLabels: Readonly<Record<OrderCardResponse["aroma"]["state"], string>> = {
  Blocked: "Заблокировано",
  Converging: "Синхронизация",
  InSync: "Синхронизировано",
  NotRequested: "Не запрошена",
  OutOfSync: "Есть расхождение",
  PendingObservation: "Ожидает наблюдения",
  UnknownOutcome: "Результат неизвестен",
};

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.problem.code === "ORDER_VERSION_CONFLICT";
}

function isStaleQuote(error: unknown): boolean {
  return error instanceof ApiError && error.problem.code === "ORDER_QUOTE_STALE";
}

export function OrderCardPage(): ReactElement {
  const { orderRef = "" } = useParams();
  return <OrderCardContent key={orderRef} orderRef={orderRef} />;
}

function OrderCardContent({ orderRef }: Readonly<{ orderRef: string }>): ReactElement {
  const session = useSession();
  const queryClient = useQueryClient();
  const [routeParams] = useSearchParams();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OrderItem>();
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcileReason, setReconcileReason] = useState("");
  const [reconciliationProjectionVersion, setReconciliationProjectionVersion] = useState<string>();
  const dialogReturnFocusRef = useRef<HTMLButtonElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const reconcileReasonRef = useRef<HTMLInputElement>(null);
  const itemsHeadingRef = useRef<HTMLHeadingElement>(null);
  const orderKey = queryKeys.orderDetail(orderRef);
  const order = useOrderCard(session.actorRef, orderRef);
  const quoteAndPut = useQuoteAndPutItem(session.actorRef, orderRef);
  const removeItem = useDeleteOrderItem(session.actorRef, orderRef, () => {
    setDeleteTarget(undefined);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => itemsHeadingRef.current?.focus()));
  });
  const confirmOrder = useConfirmOrder(session.actorRef, orderRef, () => setConfirmOpen(false));
  const reconcile = useRequestReconciliation(session.actorRef, orderRef, () => {
    setReconciliationProjectionVersion(queryClient.getQueryData<OrderCardResponse>(orderKey)?.projectionVersion);
    setReconcileOpen(false);
    setReconcileReason("");
  });
  const mutationErrors = [quoteAndPut.error, removeItem.error, confirmOrder.error, reconcile.error];
  const conflictError = mutationErrors.find(isConflict);
  const currentError = mutationErrors.find((error) => error && !isConflict(error));
  const pending = quoteAndPut.isPending || removeItem.isPending || confirmOrder.isPending || reconcile.isPending;
  const reconcileReasonError = problemFieldError(reconcile.error, "reason");

  useEffect(() => {
    if (reconcile.isError && reconcileReasonError) reconcileReasonRef.current?.focus();
  }, [reconcile.isError, reconcileReasonError]);

  const closeReconcileDialog = (): void => {
    if (reconcile.isPending) return;
    setReconcileOpen(false);
    setReconcileReason("");
    reconcile.reset();
  };

  const resetMutationErrors = (): void => {
    quoteAndPut.reset();
    removeItem.reset();
    confirmOrder.reset();
    reconcile.reset();
  };

  if (!/^ord_[0-9A-HJKMNP-TV-Z]{26}$/u.test(orderRef)) return <ProblemAlert error={new Error("Некорректный orderRef в deep link")} />;
  if (order.isPending) return <Loading label="Загружаем Order Card" />;
  if (order.isError && order.error instanceof ApiError && order.error.problem.status === 404) return (
    <>
      <PageHeader description="Карточка не найдена или больше недоступна текущему оператору." eyebrow="ЗАКАЗ">Заказ не найден</PageHeader>
      <Alert title="Заказ не найден" tone="warning">Вернитесь к клиентам и начните создание заказа заново. <Link href="/app/customers">Перейти к клиентам</Link></Alert>
    </>
  );
  if (order.isError && order.error instanceof ApiError && order.error.problem.status === 403) return <ProblemAlert error={order.error} />;
  if (order.isError && (isFatalOrderCardReadError(order.error) || !order.data)) return <ProblemAlert error={order.error} onRefresh={() => void order.refetch()} />;
  if (!order.data) return <Loading label="Загружаем Order Card" />;
  const card = order.data;
  const editable = card.allowedActions.includes("edit-items");
  const confirmable = card.allowedActions.includes("confirm");
  const hasUnsavedQuantities = editable && card.items.some((item) => {
    const quantity = quantities[item.itemRef];
    return quantity !== undefined && quantity !== item.quantity;
  });
  const waitingForReconciliationRefresh = reconcile.isSuccess && (
    reconciliationProjectionVersion === undefined
    || compareDecimalVersion(card.projectionVersion, reconciliationProjectionVersion) <= 0
  );
  const canReconcile = card.status === "Confirmed"
    && !order.isError
    && ["OutOfSync", "Blocked", "UnknownOutcome"].includes(card.aroma.state)
    && card.allowedActions.includes("request-aroma-reconciliation");

  const productForItem = (item: OrderItem): Pick<CatalogProductSummary, "productRef" | "variantRef"> => ({
    productRef: item.productRef,
    variantRef: item.variantRef,
  });
  const hasOrderActions = confirmable || canReconcile || card.aroma.state === "UnknownOutcome";
  const actionPanel = hasOrderActions ? (
    <section className="surface command-bar">
      <div><strong>Действия заказа</strong><p>Доступны только действия, разрешённые текущим состоянием заказа.</p></div>
      <div className="command-actions">
        {confirmable ? <Button isDisabled={pending || hasUnsavedQuantities || card.items.length === 0} onPress={(event) => {
          dialogReturnFocusRef.current = event.target as HTMLButtonElement;
          setConfirmOpen(true);
        }}>Подтвердить заказ</Button> : null}
        {card.aroma.state === "UnknownOutcome" ? <Button isDisabled={order.isFetching} onPress={() => void order.refetch()} variant="secondary">Проверить состояние</Button> : null}
        {canReconcile ? <Button isDisabled={pending || order.isFetching || waitingForReconciliationRefresh} onPress={(event) => {
          dialogReturnFocusRef.current = event.target as HTMLButtonElement;
          setReconcileOpen(true);
        }} variant="secondary">Запросить сверку AROMA</Button> : null}
      </div>
    </section>
  ) : null;

  return (
    <>
      <PageHeader description={`Заказ ${card.orderRef} · версия представления ${card.projectionVersion}`} eyebrow="КАРТОЧКА ЗАКАЗА">{card.customer.displayName}</PageHeader>
      <section className="order-summary surface">
        <div><span>Статус</span><Badge tone={card.status === "Draft" ? "info" : "success"}>{card.status === "Draft" ? "Черновик" : "Подтверждён"}</Badge></div>
        <div><span>Версия заказа</span><strong>{card.version}</strong></div>
        <div><span>AROMA</span><Badge tone={toneForAroma(card.aroma.state)}>{aromaLabels[card.aroma.state]}</Badge></div>
        <div><span>Итого</span><strong>{card.pricing ? formatMoney(card.pricing.totalMinor, card.pricing.currency) : "—"}</strong></div>
      </section>

      {order.isError ? <Alert title="Не удалось проверить актуальность карточки" tone="warning">Сохранённая карточка остаётся доступной. Перед следующей командой обновите данные.</Alert> : null}
      {hasUnsavedQuantities ? <Alert title="Сначала сохраните изменения количества" tone="warning">Обновите позиции или верните сохранённые значения перед подтверждением заказа.</Alert> : null}
      {card.aroma.state === "UnknownOutcome" ? <Alert title="Исход AROMA неизвестен" tone="danger">Не отправляйте команду повторно. Обновите карточку заказа или используйте доступное действие.</Alert> : null}
      {routeParams.get("notice") === "catalog-unavailable" ? <Alert title="Каталог недоступен" tone="warning">Изменение состава этого заказа больше не разрешено сервером.</Alert> : null}
      {card.aroma.blockers.map((blocker) => <Alert key={`${blocker.code}:${blocker.productRef ?? "order"}`} title={blocker.code} tone="warning">{blocker.message}</Alert>)}
      {currentError ? <ProblemAlert error={currentError} /> : null}
      {isStaleQuote(currentError) ? <Alert title="Цена устарела" tone="warning">Данные формы сохранены. Нажмите действие товара ещё раз, чтобы получить новую цену.</Alert> : null}
      {card.status === "Confirmed" ? actionPanel : null}

      <section aria-labelledby="items-title" className="surface">
        <div className="section-heading"><div><p className="eyebrow">ПОЗИЦИИ</p><h2 id="items-title" ref={itemsHeadingRef} tabIndex={-1}>Состав заказа</h2></div><span>{card.items.length}</span></div>
        {card.items.length === 0 ? <Empty description="Откройте каталог и добавьте первый товар." title="Черновик пока пуст" /> : null}
        <div className="item-list">
          {card.items.map((item) => {
            const quantity = editable ? quantities[item.itemRef] ?? item.quantity : item.quantity;
            return (
              <article aria-label={`Позиция заказа ${item.itemRef}`} className="order-item" key={item.itemRef}>
                <div><h3>{item.displayName}</h3><p>{formatMoney(item.lineTotalMinor, card.pricing?.currency)}</p><small>Позиция {item.linePosition}</small>{item.grindDisplayName ? <small>Помол: {item.grindDisplayName}</small> : null}</div>
                <Field aria-label={`Количество ${item.displayName}`} isDisabled={!editable || pending} label="Количество" onChange={(value) => setQuantities((current) => ({ ...current, [item.itemRef]: value }))} value={quantity} />
                <div className="item-actions">
                  <Button isDisabled={!editable || pending} onPress={() => quoteAndPut.mutate({ itemRef: item.itemRef, product: productForItem(item), quantity, ...(item.sourceGrindKeyHash ? { sourceGrindKeyHash: item.sourceGrindKeyHash } : {}) }, {
                    onSuccess: () => setQuantities((current) => {
                      const next = { ...current };
                      delete next[item.itemRef];
                      return next;
                    }),
                  })} size="compact" variant="secondary">Обновить</Button>
                  <Button isDisabled={!editable || pending} onPress={(event) => {
                    dialogReturnFocusRef.current = event.target as HTMLButtonElement;
                    setDeleteTarget(item);
                  }} size="compact" variant="danger">Удалить</Button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {editable ? <section className="surface command-bar"><div><strong>Добавить товар</strong><p>Поиск и получение цены выполняются в каталоге этого заказа.</p></div><Link href={`/app/catalog?orderRef=${encodeURIComponent(card.orderRef)}`}>Открыть каталог</Link></section> : null}

      {card.status === "Draft" ? actionPanel : null}

      <Dialog
        description={`Будет подтверждена версия заказа ${card.version}. После подтверждения состав нельзя изменить в этом сценарии.`}
        footer={<><Button onPress={() => setConfirmOpen(false)} ref={confirmCancelRef} variant="quiet">Отмена</Button><Button isDisabled={hasUnsavedQuantities} isPending={confirmOrder.isPending} onPress={() => {
          if (!hasUnsavedQuantities) confirmOrder.mutate();
        }}>Подтвердить</Button></>}
        initialFocusRef={confirmCancelRef}
        isKeyboardDismissDisabled={confirmOrder.isPending}
        isOpen={confirmOpen}
        onOpenChange={(open) => { if (open || !confirmOrder.isPending) setConfirmOpen(open); }}
        onRequestClose={() => !confirmOrder.isPending}
        returnFocusRef={dialogReturnFocusRef}
        title="Подтвердить заказ?"
      ><p>Проверьте состав и итоговую сумму перед отправкой команды.</p></Dialog>

      <Dialog
        {...(deleteTarget ? { description: `Позиция «${deleteTarget.displayName}» будет удалена из текущего черновика.` } : {})}
        footer={<><Button onPress={() => setDeleteTarget(undefined)} ref={deleteCancelRef} variant="quiet">Отмена</Button><Button isPending={removeItem.isPending} onPress={() => {
          if (deleteTarget) removeItem.mutate(deleteTarget.itemRef);
        }} variant="danger">Удалить</Button></>}
        initialFocusRef={deleteCancelRef}
        isKeyboardDismissDisabled={removeItem.isPending}
        isOpen={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open && !removeItem.isPending) setDeleteTarget(undefined); }}
        onRequestClose={() => !removeItem.isPending}
        returnFocusRef={dialogReturnFocusRef}
        title="Удалить позицию?"
      ><p>После успешной команды итоговая сумма будет взята из обновлённой карточки заказа.</p></Dialog>

      <Dialog
        description="Укажите причину ручной сверки. Она будет передана серверу без локальной интерпретации результата."
        footer={<><Button onPress={closeReconcileDialog} variant="quiet">Отмена</Button><Button isDisabled={reconcileReason.trim().length < 1 || reconcileReason.trim().length > 500} isPending={reconcile.isPending} onPress={() => reconcile.mutate(reconcileReason.trim())}>Отправить запрос</Button></>}
        initialFocusRef={reconcileReasonRef}
        isKeyboardDismissDisabled={reconcile.isPending || reconcileReason.length > 0}
        isOpen={reconcileOpen}
        onOpenChange={(open) => {
          if (open) setReconcileOpen(true);
          else if (!reconcile.isPending && reconcileReason.length === 0) closeReconcileDialog();
        }}
        onRequestClose={() => !reconcile.isPending && reconcileReason.length === 0}
        returnFocusRef={dialogReturnFocusRef}
        title="Запросить сверку AROMA?"
      ><Field {...(reconcileReasonError ? { errorMessage: reconcileReasonError } : {})} label="Причина" maxLength={500} onChange={setReconcileReason} ref={reconcileReasonRef} value={reconcileReason} /></Dialog>

      <Dialog
        {...(conflictError instanceof ApiError ? { description: `Correlation ID: ${conflictError.problem.correlationId}` } : {})}
        footer={<Button onPress={() => {
          void queryClient.invalidateQueries({ exact: true, queryKey: orderKey, refetchType: "none" }).then(() => order.refetch()).then((result) => {
            if (result.isSuccess) resetMutationErrors();
          });
        }} isDisabled={order.isFetching}>Обновить карточку</Button>}
        isKeyboardDismissDisabled
        isOpen={Boolean(conflictError)}
        onOpenChange={() => undefined}
        title="Заказ изменился на сервере"
      ><p>Введённое количество сохранено. После обновления снова проверьте заказ и явно повторите действие.</p></Dialog>
    </>
  );
}
