import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  Icon,
  Input,
  Link,
  Loading,
} from "../src/index.js";

describe("platform UI primitives", () => {
  it("renders a semantic button with pending behavior and an accessible icon", () => {
    const markup = renderToStaticMarkup(
      <Button isPending startIcon={<Icon name="refresh" />}>
        Сохранить
      </Button>,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("bg-primary");
    expect(markup).toContain("Сохранить");
  });

  it("keeps field labeling, description and error semantics in the DOM", () => {
    const markup = renderToStaticMarkup(
      <>
        <Field
          description="Нужен рабочий адрес"
          errorMessage="Введите адрес"
          label="Email"
        />
        <Field isInvalid label="Invalid without a message" />
        <Input aria-label="Standalone input" />
      </>,
    );

    expect(markup).toContain("Email");
    expect(markup).toContain("Нужен рабочий адрес");
    expect(markup).toContain("Введите адрес");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("Invalid without a message");
    expect(markup).toContain('aria-label="Standalone input"');
    expect(markup).toContain('data-slot="input"');
  });

  it("renders status, empty and navigation primitives with explicit semantics", () => {
    const markup = renderToStaticMarkup(
      <>
        <Alert title="Ошибка" tone="danger">
          Повторите позже
        </Alert>
        <Badge tone="warning">Ожидание</Badge>
        <Loading />
        <Empty description="Нет данных" title="Пусто" />
        <Link href="#orders">Заказы</Link>
      </>,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('href="#orders"');
    expect(markup).toContain("Пусто");
  });
});
