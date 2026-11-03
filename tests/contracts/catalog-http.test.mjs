import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogContractSchemas,
  catalogResponseSchema,
  catalogSearchQueryError,
  decodeCatalogSearchQuery,
  isCatalogPricingInput,
  isCatalogProblem,
  isCatalogOperationProblem,
  isCatalogProductRef,
  isCatalogSearchResponse,
  isCatalogVariantRef,
} from "../../packages/contracts/catalog-v1/dist/index.js";

const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const problem = {
  type: "about:blank",
  title: "VALIDATION_FAILED",
  status: 400,
  code: "VALIDATION_FAILED",
  detail: "Request validation failed",
  instance: "/api/client-v1/catalog/products",
  correlationId: "11111111-1111-4111-8111-111111111111",
  errors: [],
};

void test("Catalog query decoder validates source-contract fields and query error classification", () => {
  assert.deepEqual(decodeCatalogSearchQuery({}), {});
  for (const supplierDiscountBasisPoints of ["1000", "3500"])
    assert.deepEqual(
      decodeCatalogSearchQuery({ supplierDiscountBasisPoints }),
      { supplierDiscountBasisPoints: Number(supplierDiscountBasisPoints) },
    );
  for (const supplierDiscountBasisPoints of [
    "",
    "35",
    "3000",
    "01000",
    1000,
    null,
    ["1000", "3500"],
  ])
    assert.equal(
      decodeCatalogSearchQuery({ supplierDiscountBasisPoints }),
      undefined,
    );

  assert.deepEqual(decodeCatalogSearchQuery({ query: "coffee" }), {
    query: "coffee",
  });
  assert.deepEqual(decodeCatalogSearchQuery({ query: "ﬃ" }), { query: "ﬃ" });
  assert.deepEqual(decodeCatalogSearchQuery({ query: `${"x".repeat(200)} ` }), {
    query: `${"x".repeat(200)} `,
  });
  assert.deepEqual(
    decodeCatalogSearchQuery({
      query: "coffee",
      availability: "Available",
      limit: "50",
      cursor: "abc_-",
    }),
    {
      query: "coffee",
      availability: "Available",
      limit: 50,
      cursor: "abc_-",
    },
  );
  for (const invalid of [
    null,
    [],
    { query: "" },
    { query: " " },
    { query: "x" },
    { query: "coffee", limit: "0" },
    { query: "coffee", limit: "01" },
    { query: "coffee", limit: "51" },
    { query: "coffee", limit: 5 },
    { query: "coffee", limit: ["1", "2"] },
    { query: "coffee", availability: "unknown" },
    { query: "coffee", cursor: "bad!" },
    { query: "coffee", unexpected: true },
  ])
    assert.equal(
      decodeCatalogSearchQuery(invalid),
      undefined,
      JSON.stringify(invalid),
    );
  assert.equal(
    catalogSearchQueryError({ query: "coffee", cursor: "bad!" }),
    "INVALID_CURSOR",
  );
  assert.equal(catalogSearchQueryError({ cursor: "bad!" }), "INVALID_CURSOR");
  assert.equal(
    catalogSearchQueryError({ query: "x", cursor: "bad!" }),
    "VALIDATION_FAILED",
  );
  assert.equal(
    catalogSearchQueryError({ query: "coffee", cursor: ["a", "b"] }),
    "VALIDATION_FAILED",
  );
});

void test("Catalog product, variant, search response and pricing input validators follow source schemas", () => {
  assert.equal(isCatalogProductRef(productRef), true);
  assert.equal(isCatalogProductRef("prd_01ARZ3NDEKTSV4RRFFQ69G5FAI"), false);
  assert.equal(isCatalogVariantRef(variantRef), true);
  assert.equal(isCatalogVariantRef("var_invalid"), false);

  const searchResponse = {
    snapshotRevision: "12",
    items: [
      {
        productRef,
        variantRef,
        displayName: "Coffee",
        unit: "gram",
        availability: "Available",
        mappingAvailable: true,
        imageUrl: "https://example.test/coffee.png",
      },
    ],
    nextCursor: null,
  };
  assert.equal(isCatalogSearchResponse(searchResponse), true);
  const promotion = {
    discountBasisPoints: 3500,
    minimumWeightRaw: "0",
    providerCreatedAt: "2026-09-14T04:55:24Z",
    providerUpdatedAt: "2026-09-14T04:55:24Z",
  };
  for (const supplierPromotions of [
    [],
    [promotion],
    [{ ...promotion, discountBasisPoints: 1000, minimumWeightRaw: "0.25" }],
  ])
    assert.equal(
      isCatalogSearchResponse({
        ...searchResponse,
        items: [{ ...searchResponse.items[0], supplierPromotions }],
      }),
      true,
    );
  for (const supplierPromotions of [
    null,
    [{ ...promotion, discountBasisPoints: 10001 }],
    [{ ...promotion, minimumWeightRaw: "-1" }],
    [{ ...promotion, providerCreatedAt: "2026-02-30T00:00:00Z" }],
    [{ ...promotion, expiresAt: "2026-09-21T00:00:00Z" }],
  ])
    assert.equal(
      isCatalogSearchResponse({
        ...searchResponse,
        items: [{ ...searchResponse.items[0], supplierPromotions }],
      }),
      false,
    );

  assert.equal(
    isCatalogSearchResponse({
      ...searchResponse,
      items: [{ ...searchResponse.items[0], categoryName: "Чай" }],
    }),
    true,
  );
  for (const categoryName of [null, "", "x".repeat(201), 42])
    assert.equal(
      isCatalogSearchResponse({
        ...searchResponse,
        items: [{ ...searchResponse.items[0], categoryName }],
      }),
      false,
    );
  assert.equal(
    isCatalogSearchResponse({
      ...searchResponse,
      items: [{ ...searchResponse.items[0], extra: true }],
    }),
    false,
  );
  assert.equal(
    isCatalogSearchResponse({ ...searchResponse, nextCursor: "x".repeat(513) }),
    false,
  );

  const pricingInput = {
    productRef,
    variantRef,
    offerRef,
    snapshotRevision: "12",
    supplierUnitMinor: "12345",
    currency: "RUB",
    unit: "gram",
    availability: "Available",
    mappingRevision: "4",
    displayName: "Coffee",
  };
  assert.equal(isCatalogPricingInput(pricingInput), true);
  assert.equal(
    isCatalogPricingInput({ ...pricingInput, supplierUnitMinor: "01" }),
    false,
  );
  assert.equal(
    isCatalogPricingInput({ ...pricingInput, currency: "USD" }),
    false,
  );
  assert.equal(
    isCatalogPricingInput({ ...pricingInput, unexpected: true }),
    false,
  );
});

void test("Catalog response schemas include declared problem statuses and reject invalid problems", () => {
  const responseSchemas = catalogResponseSchema(
    catalogContractSchemas.searchResponse,
    200,
    [400, 401, 403, 503],
  );
  assert.deepEqual(Object.keys(responseSchemas), [
    "200",
    "400",
    "401",
    "403",
    "503",
  ]);
  assert.equal(responseSchemas["200"], catalogContractSchemas.searchResponse);
  for (const status of [400, 401, 403, 503])
    assert.equal(
      responseSchemas[String(status)],
      catalogContractSchemas.problem,
    );
  assert.equal(isCatalogProblem(problem), true);
  assert.equal(isCatalogProblem({ ...problem, status: 200 }), false);
  assert.equal(isCatalogProblem({ ...problem, unrecognized: true }), false);
  assert.equal(
    isCatalogProblem({ ...problem, instance: "relative path" }),
    false,
  );
  assert.equal(
    isCatalogOperationProblem(
      {
        ...problem,
        status: 503,
        title: "CATALOG_UNAVAILABLE",
        code: "CATALOG_UNAVAILABLE",
      },
      "search",
      503,
    ),
    true,
  );
  assert.equal(
    isCatalogOperationProblem(
      {
        ...problem,
        status: 503,
        title: "CATALOG_SNAPSHOT_INCOMPLETE",
        code: "CATALOG_SNAPSHOT_INCOMPLETE",
      },
      "pricing",
      503,
    ),
    true,
  );
  assert.equal(
    isCatalogOperationProblem(
      {
        ...problem,
        status: 503,
        title: "CATALOG_PRODUCT_NOT_FOUND",
        code: "CATALOG_PRODUCT_NOT_FOUND",
      },
      "search",
      503,
    ),
    false,
  );
  assert.equal(
    isCatalogOperationProblem(
      {
        ...problem,
        status: 404,
        title: "CATALOG_PRODUCT_NOT_FOUND",
        code: "CATALOG_PRODUCT_NOT_FOUND",
      },
      "pricing",
      404,
    ),
    true,
  );
  assert.equal(
    isCatalogOperationProblem(
      {
        ...problem,
        status: 404,
        title: "CATALOG_PRODUCT_NOT_FOUND",
        code: "CATALOG_PRODUCT_NOT_FOUND",
      },
      "search",
      404,
    ),
    false,
  );
});
