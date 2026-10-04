import { useEffect, useState, type ReactElement } from "react";
import { Alert, Badge, Button, Empty, Field, Icon, Link, Loading } from "@coffee-platform/ui";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { CatalogProductSummary } from "@coffee-platform/generated-client-v1";
import { ApiError } from "../api/client.js";
import { ProblemAlert } from "../api/problem.js";
import { newUlidRef } from "../api/ulid.js";
import { useCatalogSearch, useOrderCard, useQuoteAndPutItem } from "../api/remote.js";
import { PageHeader } from "../app/PageHeader.js";
import { useSession } from "../app/session.js";


const availabilityLabels: Readonly<Record<CatalogProductSummary["availability"], string>> = {
  Available: "Доступен",
  Stopped: "Остановлен",
  Unavailable: "Недоступен",
};

const unitLabels: Readonly<Record<CatalogProductSummary["unit"], string>> = {
  gram: "грамм",
  kilogram: "килограмм",
  piece: "штука",
};


function isStaleQuote(error: unknown): boolean {
  return error instanceof ApiError && error.problem.code === "ORDER_QUOTE_STALE";
}

function isGrindUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.problem.code === "PRICING_GRIND_NOT_AVAILABLE";
}

export function CatalogPage(): ReactElement {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const orderRef = params.get("orderRef") ?? "";
  const rawQuery = params.get("q") ?? "";
  const query = rawQuery.trim().slice(0, 200);
  const cursor = params.get("cursor") ?? undefined;
  const rawAvailability = params.get("availability") ?? "Available";
  const availability: CatalogProductSummary["availability"] | "" = ["Available", "Unavailable", "Stopped", ""].includes(rawAvailability)
    ? rawAvailability as CatalogProductSummary["availability"] | ""
    : "Available";
  const validOrderRef = /^ord_[0-9A-HJKMNP-TV-Z]{26}$/u.test(orderRef);
  const [draftQuery, setDraftQuery] = useState(query);
  const [draftAvailability, setDraftAvailability] = useState(availability);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [grindSelections, setGrindSelections] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string>();
  const order = useOrderCard(session.actorRef, orderRef);
  const editable = order.data?.status === "Draft" && order.data.allowedActions.includes("edit-items");
  const products = useCatalogSearch(session.actorRef, {
    availability,
    ...(cursor ? { cursor } : {}),
    orderRef,
    q: editable ? query : "",
  });
  const addItem = useQuoteAndPutItem(session.actorRef, orderRef);

  useEffect(() => {
    if (order.data && !editable) void navigate(`/app/orders/${order.data.orderRef}?notice=catalog-unavailable`, { replace: true });
  }, [editable, navigate, order.data]);

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  useEffect(() => {
    if (rawQuery === query && rawAvailability === availability) return;
    const next = new URLSearchParams(params);
    if (query) next.set("q", query);
    else next.delete("q");
    if (availability) next.set("availability", availability);
    else next.delete("availability");
    next.delete("cursor");
    setParams(next, { replace: true });
  }, [availability, params, query, rawAvailability, rawQuery, setParams]);

  useEffect(() => {
    const normalized = draftQuery.trim();
    if (normalized === query || (normalized.length > 0 && normalized.length < 2)) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams({ orderRef });
      if (normalized) next.set("q", normalized);
      if (draftAvailability) next.set("availability", draftAvailability);
      setParams(next);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draftAvailability, draftQuery, orderRef, query, setParams]);

  const submitSearch = (): void => {
    const next = new URLSearchParams({ orderRef });
    if (draftQuery.trim()) next.set("q", draftQuery.trim());
    if (draftAvailability) next.set("availability", draftAvailability);
    setParams(next);
  };

  if (!validOrderRef) {
    return <Alert title="Не выбран заказ" tone="warning">Откройте <Link href="/app/customers">поиск клиентов</Link> и создайте черновик заказа.</Alert>;
  }
  if (order.isPending) return <Loading label="Проверяем заказ" />;
  if (order.isError) return <ProblemAlert error={order.error} onRefresh={() => void order.refetch()} />;
  if (!editable) return <Loading label="Возвращаемся к карточке заказа" />;

  return (
    <>
      <PageHeader description={`Добавление товаров в заказ ${orderRef}`} eyebrow="ШАГ 3 · КАТАЛОГ">Поиск товаров</PageHeader>
      {added ? <Alert title="Товар добавлен" tone="success">Карточка заказа обновлена. <Link href={`/app/orders/${added}`}>К заказу</Link></Alert> : null}
      {isStaleQuote(addItem.error) ? <Alert title="Цена устарела" tone="warning">Товар не добавлен. Обновите поиск и получите новую цену.</Alert> : null}
      {isGrindUnavailable(addItem.error) ? <Alert title="Помол недоступен" tone="warning">Товар не добавлен. Выберите подтверждённый вариант помола и повторите действие.</Alert> : null}
      <section className="surface search-surface">
        <div className="search-row catalog-search-row">
          <Field aria-label="Поиск товара" label="Название товара" maxLength={200} onChange={setDraftQuery} value={draftQuery} />
          <label className="select-field">Доступность
            <select onChange={(event) => setDraftAvailability(event.target.value as CatalogProductSummary["availability"] | "")} value={draftAvailability}>
              <option value="">Все</option>
              <option value="Available">Доступные</option>
              <option value="Unavailable">Недоступные</option>
              <option value="Stopped">Остановленные</option>
            </select>
          </label>
          <Button onPress={submitSearch} startIcon={<Icon name="search" />}>Найти</Button>
          <Link href={`/app/orders/${orderRef}`}>К заказу</Link>
        </div>
        {query.length > 0 && query.length < 2 ? <Alert title="Слишком короткий запрос" tone="warning">Введите не менее двух символов.</Alert> : null}
        {query.length === 0 ? <Empty description="Введите название — поиск начнётся через 300 мс после ввода." title="Начните поиск товара" /> : null}
        {products.isPending && query.length >= 2 ? <Loading label="Ищем товары" /> : null}
        {products.isError ? <ProblemAlert error={products.error} /> : null}
        {addItem.isError && !isStaleQuote(addItem.error) && !isGrindUnavailable(addItem.error) ? <ProblemAlert error={addItem.error} /> : null}
        {products.isSuccess && products.data.items.length === 0 ? <Empty description="Измените запрос или фильтр доступности." title="Товары не найдены" /> : null}
        <div className="product-grid">
          {products.data?.items.map((product) => {
            const key = `${product.productRef}:${product.variantRef}`;
            const quantity = quantities[key] ?? "1";
            const grindOptions = product.grindOptions ?? [];
            const selectedGrindHash = grindSelections[key] ?? "";
            const selectedGrindUnavailable = selectedGrindHash !== "" && !grindOptions.some((option) => option.sourceGrindKeyHash === selectedGrindHash);
            return (
              <article className="product-card" key={key}>
                <div className="product-card-heading"><Badge tone={product.availability === "Available" ? "success" : "warning"}>{availabilityLabels[product.availability]}</Badge><span>{unitLabels[product.unit]}</span></div>
                <h2>{product.displayName}</h2>
                <small>{product.mappingAvailable ? "Привязка к AROMA доступна" : "Нет привязки к AROMA"}</small>
                <Field aria-label={`Количество для ${product.displayName}`} label="Количество" onChange={(value) => setQuantities((current) => ({ ...current, [key]: value }))} value={quantity} />
                {grindOptions.length > 0 || selectedGrindUnavailable ? <label className="select-field">Помол
                  <select aria-label={`Помол для ${product.displayName}`} onChange={(event) => setGrindSelections((current) => ({ ...current, [key]: event.target.value }))} value={selectedGrindHash}>
                    <option value="">Без выбора</option>
                    {selectedGrindUnavailable ? <option disabled value={selectedGrindHash}>Выбранный помол недоступен</option> : null}
                    {grindOptions.map((option) => <option key={option.sourceGrindKeyHash} value={option.sourceGrindKeyHash}>{option.displayName}</option>)}
                  </select>
                </label> : null}
                <Button isDisabled={product.availability !== "Available" || !product.mappingAvailable || !quantity.trim()} isPending={addItem.isPending} onPress={() => addItem.mutate(
                  { itemRef: newUlidRef("itm"), product, quantity, ...(grindSelections[key] ? { sourceGrindKeyHash: grindSelections[key] } : {}) },
                  { onSuccess: (next) => setAdded(next.orderRef) },
                )}>Добавить</Button>
              </article>
            );
          })}
        </div>
        {products.data?.nextCursor ? <Button onPress={() => {
          const next = new URLSearchParams(params);
          next.set("cursor", products.data?.nextCursor ?? "");
          setParams(next);
        }} variant="quiet">Следующая страница</Button> : null}
      </section>
    </>
  );
}
