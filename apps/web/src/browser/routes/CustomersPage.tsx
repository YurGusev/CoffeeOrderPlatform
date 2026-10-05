import { useEffect, useRef, useState, type ReactElement } from "react";
import { Alert, Button, Dialog, Empty, Field, Icon, Loading } from "@coffee-platform/ui";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { CustomerCreateRequest } from "@coffee-platform/generated-client-v1";
import { ApiError } from "../api/client.js";
import { ProblemAlert, problemFieldError } from "../api/problem.js";
import { formatPrivatePhone } from "../api/format.js";
import { useCreateCustomer, useCustomerSearch } from "../api/remote.js";
import { PageHeader } from "../app/PageHeader.js";
import { useSession } from "../app/session.js";

export function CustomersPage(): ReactElement {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const rawQuery = params.get("q") ?? "";
  const query = rawQuery.trim().slice(0, 200);
  const cursor = params.get("cursor") ?? undefined;
  const [draftQuery, setDraftQuery] = useState(query);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ displayName: "", email: "", phone: "" });
  const [formError, setFormError] = useState<string>();
  const displayNameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const newCustomerButtonRef = useRef<HTMLButtonElement>(null);
  const customers = useCustomerSearch(session.actorRef, query, cursor);
  const createCustomer = useCreateCustomer(session.actorRef);
  const items = customers.data?.items ?? [];
  const customerAccessDenied = customers.error instanceof ApiError && customers.error.problem.status === 403;
  const displayNameError = problemFieldError(createCustomer.error, "displayName")
    ?? (formError && !form.displayName.trim() ? "Укажите имя." : undefined);
  const phoneError = problemFieldError(createCustomer.error, "phone")
    ?? (formError && !form.phone.trim() && !form.email.trim() ? "Укажите телефон или email." : undefined);
  const emailError = problemFieldError(createCustomer.error, "email");
  const customerFormDirty = Object.values(form).some((value) => value.length > 0);

  const closeCustomerDialog = (force = false): void => {
    if (createCustomer.isPending && !force) return;
    setDialogOpen(false);
    setForm({ displayName: "", email: "", phone: "" });
    setFormError(undefined);
    createCustomer.reset();
  };

  useEffect(() => {
    if (!createCustomer.isError) return;
    const target = displayNameError ? displayNameRef.current : phoneError ? phoneRef.current : emailError ? emailRef.current : undefined;
    target?.focus();
  }, [createCustomer.isError, displayNameError, emailError, phoneError]);

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  useEffect(() => {
    if (rawQuery === query) return;
    const next = new URLSearchParams(params);
    if (query) next.set("q", query);
    else next.delete("q");
    next.delete("cursor");
    setParams(next, { replace: true });
  }, [params, query, rawQuery, setParams]);

  useEffect(() => {
    const normalized = draftQuery.trim();
    if (normalized === query || (normalized.length > 0 && normalized.length < 2)) return;
    const timer = window.setTimeout(() => setParams(normalized ? { q: normalized } : {}), 300);
    return () => window.clearTimeout(timer);
  }, [draftQuery, query, setParams]);

  const submitSearch = (): void => {
    const normalized = draftQuery.trim();
    setParams(normalized ? { q: normalized } : {});
  };
  const submitCustomer = (): void => {
    const displayName = form.displayName.trim();
    const phone = form.phone.trim();
    const email = form.email.trim();
    if (!displayName || (!phone && !email)) {
      setFormError("Укажите имя и хотя бы телефон или email.");
      return;
    }
    setFormError(undefined);
    const body: CustomerCreateRequest = phone
      ? { displayName, phone, ...(email ? { email } : {}) }
      : { displayName, email };
    createCustomer.mutate(body, {
      onSuccess: (customer) => {
        closeCustomerDialog(true);
        void navigate(`/app/orders/new?customerRef=${encodeURIComponent(customer.customerRef)}`);
      },
    });
  };

  return (
    <>
      <PageHeader description="Найдите существующего клиента или создайте нового перед заказом." eyebrow="ШАГ 1 · КЛИЕНТ">Клиенты</PageHeader>
      <section className="surface search-surface">
        <div className="search-row">
          <Field aria-label="Поиск клиента" label="Имя, телефон или email" maxLength={200} onChange={setDraftQuery} value={draftQuery} />
          <Button onPress={submitSearch} startIcon={<Icon name="search" />}>Найти</Button>
          <Button onPress={() => setDialogOpen(true)} ref={newCustomerButtonRef} startIcon={<Icon name="add" />} variant="secondary">Новый клиент</Button>
        </div>
        {query.length > 0 && query.length < 2 ? <Alert title="Слишком короткий запрос" tone="warning">Введите не менее двух символов.</Alert> : null}
        {query.length === 0 ? <Empty description="Введите имя, телефон или email — поиск начнётся через 300 мс после ввода." title="Начните поиск клиента" /> : null}
        {customers.isPending && query.length >= 2 ? <Loading label="Ищем клиентов" /> : null}
        {customers.isError ? <ProblemAlert error={customers.error} {...(customerAccessDenied ? {} : { onRefresh: () => void customers.refetch() })} /> : null}
        {customers.isSuccess && items.length === 0 ? <Empty description="Измените запрос или создайте клиента." title="Клиенты не найдены" /> : null}
        <div className="result-list">
          {!customerAccessDenied ? items.map((customer) => (
            <article className="result-card" key={customer.customerRef}>
              <div><h2>{customer.displayName}</h2><p>{customer.phone ? formatPrivatePhone(customer.phone) : (customer.email ?? "Контакты не указаны")}</p><small>{customer.customerRef}</small></div>
              <Button onPress={() => navigate(`/app/orders/new?customerRef=${encodeURIComponent(customer.customerRef)}`)} variant="secondary">Выбрать</Button>
            </article>
          )) : null}
        </div>
        {!customerAccessDenied && customers.data?.nextCursor ? <Button onPress={() => setParams({ q: query, cursor: customers.data.nextCursor ?? "" })} variant="quiet">Следующая страница</Button> : null}
      </section>

      <Dialog
        description="Контактные данные валидирует Customer owner. Поля формы сохраняются при серверной ошибке."
        footer={<><Button onPress={() => closeCustomerDialog()} variant="quiet">Отмена</Button><Button isPending={createCustomer.isPending} onPress={submitCustomer}>Создать и выбрать</Button></>}
        initialFocusRef={displayNameRef}
        isOpen={dialogOpen}
        isKeyboardDismissDisabled={createCustomer.isPending || customerFormDirty}
        onOpenChange={(open) => {
          if (open) setDialogOpen(true);
          else if (!createCustomer.isPending && !customerFormDirty) closeCustomerDialog();
        }}
        onRequestClose={() => !createCustomer.isPending && !customerFormDirty}
        returnFocusRef={newCustomerButtonRef}
        title="Новый клиент"
      >
        <div className="form-stack">
          <Field {...(displayNameError ? { errorMessage: displayNameError } : {})} label="Имя" onChange={(displayName) => setForm((value) => ({ ...value, displayName }))} ref={displayNameRef} value={form.displayName} />
          <Field {...(phoneError ? { errorMessage: phoneError } : {})} label="Телефон" onChange={(phone) => setForm((value) => ({ ...value, phone }))} ref={phoneRef} value={form.phone} />
          <Field {...(emailError ? { errorMessage: emailError } : {})} label="Email" onChange={(email) => setForm((value) => ({ ...value, email }))} ref={emailRef} type="email" value={form.email} />
          {formError ? <Alert title="Проверьте форму" tone="warning">{formError}</Alert> : null}
          {createCustomer.isError ? <ProblemAlert error={createCustomer.error} /> : null}
        </div>
      </Dialog>
    </>
  );
}
