import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  escapeLikePrefix,
  maskEmail,
  monotonicUlid,
  normalizeCustomerCreate,
  normalizeSearchQuery,
} from "../../apps/customer-service/dist/domain/customer.js";
import { createCustomer } from "../../apps/customer-service/dist/application/create-customer.js";
import { getCustomerOrderInput } from "../../apps/customer-service/dist/application/get-customer-order-input.js";
import { searchCustomers } from "../../apps/customer-service/dist/application/search-customers.js";

void test("Customer normalization uses the emitted owner domain implementation", () => {
  const value = normalizeCustomerCreate({
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
  assert.equal(value.displayName, "Café Bar");
  assert.equal(value.displayNameSearch, "café bar");
  assert.equal(value.phoneE164, "+79991234567");
  assert.equal(value.emailNormalized, "alice@xn--r8jz45g.xn--zckzah");
  assert.equal(maskEmail(value.emailNormalized), "a***@xn--r8jz45g.xn--zckzah");
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
    {
      displayName: "ok",
      phone: "+79991234567",
      address: { line1: "Street", city: "City", countryCode: "RUS" },
    },
  ]) {
    assert.throws(() => normalizeCustomerCreate(invalid));
  }
});

void test("Customer search selects contact modes and rejects malformed query boundaries", () => {
  const phone = normalizeSearchQuery(" 8 (999) 123-45-67 ");
  assert.equal(phone.mode, "phone");
  assert.equal(phone.value, "+79991234567");
  assert.match(phone.queryHash, /^[0-9a-f]{64}$/u);

  const email = normalizeSearchQuery(" Alice@Example.Test ");
  assert.equal(email.mode, "email");
  assert.equal(email.value, "alice@example.test");

  const name = normalizeSearchQuery("  Café\tBar  ");
  assert.equal(name.mode, "name");
  assert.equal(name.value, "café bar");
  assert.equal(escapeLikePrefix(String.raw`a\_%`), String.raw`a\\\_\%`);

  for (const invalid of ["x", "q".repeat(201), "@invalid"]) {
    assert.throws(() => normalizeSearchQuery(invalid), {
      code: "VALIDATION_FAILED",
    });
  }
});

void test("Customer ULIDs stay valid and ordered; search fails closed without a cursor signer", async () => {
  const first = monotonicUlid();
  const second = monotonicUlid();
  assert.match(first, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.match(second, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.ok(second > first);

  let storeCalls = 0;
  await assert.rejects(
    searchCustomers(
      {
        async search() {
          storeCalls += 1;
          return [];
        },
      },
      { query: "customer" },
      undefined,
    ),
    { code: "CUSTOMER_UNAVAILABLE" },
  );
  assert.equal(storeCalls, 0);
});

void test("Customer application validates command identity before creating and forwards its signal", async () => {
  const calls = [];
  const store = {
    async create(input) {
      calls.push(input);
      return {
        status: 201,
        body: { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      };
    },
  };
  const command = {
    actorRef: "usr_test",
    scope: "a".repeat(64),
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    body: { displayName: "  Test  Customer ", phone: "+79991234567" },
  };
  const controller = new AbortController();

  assert.deepEqual(
    await createCustomer(store, { ...command, signal: controller.signal }),
    {
      status: 201,
      body: { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actorRef, "usr_test");
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[0].input.displayName, "Test Customer");
  assert.equal(calls[0].input.phoneE164, "+79991234567");

  for (const invalid of [
    { ...command, actorRef: "not valid" },
    { ...command, actorRef: "u".repeat(65) },
    { ...command, scope: "not-a-scope" },
    { ...command, idempotencyKey: "not-a-uuid" },
    { ...command, correlationId: "not-a-uuid" },
  ]) {
    await assert.rejects(createCustomer(store, invalid), {
      code: "VALIDATION_FAILED",
    });
  }
  assert.equal(calls.length, 1);
});

void test("Customer order input maps invalid and absent customers to not found", async () => {
  const customerRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const calls = [];
  const result = {
    customerRef,
    customerVersion: "3",
    displayName: "Test Customer",
    state: "Active",
  };
  const store = {
    async getOrderInput(...args) {
      calls.push(args);
      return result;
    },
  };
  const controller = new AbortController();

  assert.equal(
    await getCustomerOrderInput(store, customerRef, controller.signal),
    result,
  );
  assert.deepEqual(calls, [[customerRef, controller.signal]]);
  await assert.rejects(getCustomerOrderInput(store, "invalid-ref"), {
    code: "CUSTOMER_NOT_FOUND",
  });
  assert.equal(calls.length, 1);

  await assert.rejects(
    getCustomerOrderInput({ getOrderInput: async () => null }, customerRef),
    { code: "CUSTOMER_NOT_FOUND" },
  );
});
