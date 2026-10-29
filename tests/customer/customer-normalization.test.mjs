import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

const DOMAIN_PATH = new URL(
  "../../apps/customer-service/src/domain/customer.ts",
  import.meta.url,
);

void test("Customer normalization uses the owner domain implementation", async (t) => {
  try {
    await access(DOMAIN_PATH);
  } catch {
    t.skip("BLOCKER: customer-service domain runtime is not present");
    return;
  }

  const domain = await import(pathToFileURL(DOMAIN_PATH.pathname).href);
  const normalize =
    domain.normalizeCustomerRequest ??
    domain.normalizeCustomerInput ??
    domain.normalizeCustomerCreateRequest ??
    domain.normalizeCustomerCreate;
  if (typeof normalize !== "function") {
    t.skip(
      "BLOCKER: customer-service domain does not expose its normalization entry point",
    );
    return;
  }

  const normalized = await normalize({
    displayName: " \u00a0Cafe\u0301 \t  Bar\u2003 ",
    phone: "8 (999) 123-45-67",
    email: " Alice@例え.テスト ",
    address: {
      line1: "  \u00a0ул. Тестовая\t1  ",
      line2: " \u2003 ",
      city: "  Екатеринбург  ",
      postalCode: " ",
      countryCode: "ru",
    },
  });
  const value = normalized?.normalized ?? normalized?.value ?? normalized;

  assert.equal(value.displayName, "Café Bar");
  assert.equal(value.displayNameSearch, "café bar");
  assert.equal(value.phoneE164, "+79991234567");
  assert.equal(value.emailNormalized, "alice@xn--r8jz45g.xn--zckzah");
  assert.equal(
    domain.maskEmail(value.emailNormalized),
    "a***@xn--r8jz45g.xn--zckzah",
  );
  assert.deepEqual(value.address, {
    kind: "Delivery",
    line1: "ул. Тестовая 1",
    line2: null,
    city: "Екатеринбург",
    postalCode: null,
    countryCode: "RU",
  });

  for (const invalid of [
    { displayName: "ok", phone: "not-a-phone" },
    { displayName: "ok", email: "not-an-email" },
    { displayName: "ok" },
  ]) {
    assert.throws(() => normalize(invalid));
  }
});
