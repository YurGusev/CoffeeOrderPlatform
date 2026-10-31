import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeTastyCatalogResponse } from "../../apps/tasty-gateway/dist/infrastructure/provider/catalog-decoder.js";

const fixture = await readFile(
  new URL(
    "../../evidence/tasty/catalog-decoder-inputs/catalog-decoder-fixture.json",
    import.meta.url,
  ),
  "utf8",
);
const response = () => JSON.parse(fixture);
const encode = (value) => JSON.stringify(value);

void test("декодирует выбранные поля и точные числовые лексемы одного ответа", () => {
  const decoded = decodeTastyCatalogResponse(fixture);
  assert.equal(decoded.products.length, 2);
  assert.deepEqual(
    decoded.products[0].offers.map(({ id, type }) => [id, type]),
    [
      ["201", "bean_coffee"],
      ["202", "ground_coffee"],
    ],
  );
  assert.equal(decoded.products[0].quantityKgRaw, "9999750");
  assert.equal(decoded.products[0].offers[0].priceRaw, "490.8");
  assert.equal(decoded.products[0].offers[0].discountRaw, "30");
  assert.equal(decoded.products[0].offers[1].discountRaw, null);
  assert.deepEqual(decoded.products[0].offers[1].grindings, [
    { id: "401", name: "Помол A" },
  ]);
  assert.deepEqual(decoded.products[0].offers[0].packages, [
    { id: "301", name: "Упаковка A" },
  ]);
  assert.deepEqual(
    decoded.products[1].offers.map(({ priceRaw }) => priceRaw),
    ["604.5", "425.8"],
  );
  assert.equal(decoded.products[1].type, null);
  assert.equal(decoded.products[1].notAvailable, true);
  assert.equal(decoded.products[1].offers[1].notAvailable, false);
  const precise = fixture.replace('"price": 490.8', '"price": 490.800');
  assert.equal(
    decodeTastyCatalogResponse(precise).products[0].offers[0].priceRaw,
    "490.800",
  );
  assert.deepEqual(decodeTastyCatalogResponse('{"data":[],"meta":{}}'), {
    products: [],
  });
  const extra = response();
  extra.meta.last_order_address = "private";
  extra.data[0].provider_extra = "private";
  assert.equal(
    JSON.stringify(decodeTastyCatalogResponse(encode(extra))).includes(
      "private",
    ),
    false,
  );
});

// Отрицательные случаи синтетические; fixture не является raw response.
void test("отклоняет неполные, ошибочные и недоказанные входы без defaults и округления", () => {
  for (const body of [undefined, "", "  ", '{"data":[]}', '{"meta":{}}']) {
    assert.throws(() => decodeTastyCatalogResponse(body), {
      code: "TASTY_CATALOG_INCOMPLETE",
    });
  }
  for (const body of [
    "{",
    '{"data":{},"meta":{}}',
    '{"data":[],"meta":null}',
    "false",
  ]) {
    assert.throws(() => decodeTastyCatalogResponse(body), {
      code: "TASTY_CATALOG_INVALID",
    });
  }
  const noDiscount = response();
  delete noDiscount.data[0].offers[0].discount;
  assert.throws(() => decodeTastyCatalogResponse(encode(noDiscount)), {
    code: "TASTY_CATALOG_INCOMPLETE",
  });
  const noAvailableAt = response();
  delete noAvailableAt.data[0].available_at;
  assert.throws(() => decodeTastyCatalogResponse(encode(noAvailableAt)), {
    code: "TASTY_CATALOG_INCOMPLETE",
  });
  const noGrindings = response();
  delete noGrindings.data[0].offers[0].grindings;
  assert.throws(() => decodeTastyCatalogResponse(encode(noGrindings)), {
    code: "TASTY_CATALOG_INCOMPLETE",
  });
  const wrongBoolean = response();
  wrongBoolean.data[0].not_available = "false";
  assert.throws(() => decodeTastyCatalogResponse(encode(wrongBoolean)), {
    code: "TASTY_CATALOG_INVALID",
  });
  const wrongPrice = response();
  wrongPrice.data[0].offers[0].price = "490.8";
  assert.throws(() => decodeTastyCatalogResponse(encode(wrongPrice)), {
    code: "TASTY_CATALOG_INVALID",
  });
  for (const token of ["9007199254740993", "1.0", "1e2", "0", '"101"']) {
    assert.throws(
      () =>
        decodeTastyCatalogResponse(
          fixture.replace('"id": 101', `"id": ${token}`),
        ),
      { code: "TASTY_CATALOG_INVALID" },
    );
  }
  for (const token of ["1e2", "-1"]) {
    assert.throws(
      () =>
        decodeTastyCatalogResponse(
          fixture.replace('"price": 490.8', `"price": ${token}`),
        ),
      { code: "TASTY_CATALOG_MONEY_NOT_PROVEN" },
    );
  }
  assert.throws(() => decodeTastyCatalogResponse(response()), {
    code: "TASTY_CATALOG_MONEY_NOT_PROVEN",
  });
});
