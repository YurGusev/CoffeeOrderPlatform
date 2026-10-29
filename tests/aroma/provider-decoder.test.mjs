import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  decodeCartSnapshot,
  decodeCatalogPage,
  decodeProviderRejection,
} from "../../apps/aroma-gateway/dist/infrastructure/provider/decoder.js";
import { decodeProviderGrinds } from "../../apps/aroma-gateway/dist/application/provider-grinds.js";

const capture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(
        `../../evidence/aroma-provider/2026-09-12-cart-mutations/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

void test("decoder отличает полный пустой cart от partial и сохраняет offer id отдельно от cart-line id", async () => {
  const emptyBody = await capture("initial-cart.json");
  const empty = decodeCartSnapshot(emptyBody);
  assert.equal(empty.kind, "empty");
  assert.deepEqual(empty.lines, []);

  const populated = decodeCartSnapshot(await capture("add-one-get.json"));
  assert.equal(populated.kind, "non-empty");
  assert.equal(populated.lines.length, 1);
  assert.notEqual(populated.lines[0].cartLineId, populated.lines[0].offerId);
  assert.equal(populated.lines[0].offerPriceRaw, "852.6");
  assert.equal(populated.lines[0].quantity, 1);

  assert.throws(() => decodeCartSnapshot({ products: [] }), {
    code: "ProviderDecodeIncomplete",
  });
  assert.throws(
    () =>
      decodeCartSnapshot({
        products: [],
        prices: { total: { default: 0, promo: 0 } },
      }),
    { code: "ProviderDecodeIncomplete" },
  );
  for (const key of ["default", "promo"]) {
    assert.throws(
      () =>
        decodeCartSnapshot({
          ...emptyBody,
          prices: {
            ...emptyBody.prices,
            total: { ...emptyBody.prices.total, [key]: 1 },
          },
        }),
      { code: "ProviderDecodeInvalid" },
    );
  }
  for (const key of ["categories", "weights", "discounts", "prices"]) {
    assert.throws(
      () =>
        decodeCartSnapshot({
          ...emptyBody,
          prices: { ...emptyBody.prices, [key]: [{}] },
        }),
      { code: "ProviderDecodeInvalid" },
    );
  }
  const raw = await capture("add-one-get.json");
  assert.throws(
    () =>
      decodeCartSnapshot({
        ...raw,
        products: [{ id: 1, offer: { id: 2, price: 1.2 }, quantity: 1 }],
      }),
    { code: "ProviderDecodeIncomplete" },
  );
  assert.throws(
    () =>
      decodeCartSnapshot({
        ...raw,
        products: [raw.products[0], raw.products[0]],
      }),
    { code: "ProviderDecodeInvalid" },
  );
  const twoGrinds = {
    ...raw,
    products: [
      { ...raw.products[0], id: 300001, grind_id: "1" },
      { ...raw.products[0], id: 300002, grind_id: "2" },
    ],
  };
  assert.equal(decodeCartSnapshot(twoGrinds).lines.length, 2);
});

void test("decoder принимает фактическую catalog page и проверяет использованные поля", async () => {
  const pageText = await readFile(
    new URL(
      "../../evidence/aroma-provider/2026-09-12-authenticated/catalog-page1.json",
      import.meta.url,
    ),
    "utf8",
  );
  const page = JSON.parse(pageText);
  const decoded = decodeCatalogPage(page);
  assert.equal(decoded.currentPage, 1);
  assert.ok(decoded.products.length > 0);
  assert.equal(decoded.products[0].productOnStop, false);
  assert.equal(decoded.products[0].showOnWholesale, true);
  assert.equal(decoded.products[0].soldByPiece, false);
  assert.equal(decoded.products[0].previewPath, null);
  assert.ok((decoded.products[0].photoPaths?.length ?? 0) > 0);
  assert.deepEqual(decoded.products[0].offers[0].params, [
    { slug: "weight", value: "25" },
  ]);
  assert.equal(decoded.products[0].offers[0].priceRaw, "0");
  assert.throws(
    () =>
      decodeCatalogPage({
        ...page,
        data: [
          {
            ...page.data[0],
            offers: [{ ...page.data[0].offers[0], price: "not-a-decimal" }],
          },
        ],
      }),
    { code: "ProviderDecodeInvalid" },
  );
  for (const price of [Number.MAX_SAFE_INTEGER + 1, 12.3, -1])
    assert.throws(
      () =>
        decodeCatalogPage({
          ...page,
          data: [
            { ...page.data[0], offers: [{ ...page.data[0].offers[0], price }] },
          ],
        }),
      { code: "ProviderDecodeInvalid" },
    );

  const fractionalText = pageText.replace(/("price"\s*:\s*)0/u, "$112.30");
  assert.notEqual(fractionalText, pageText);
  const fractional = decodeCatalogPage(fractionalText);
  assert.equal(fractional.products[0].offers[0].priceRaw, "12.30");
  const fractionalBytes = decodeCatalogPage(
    new TextEncoder().encode(fractionalText),
  );
  assert.equal(fractionalBytes.products[0].offers[0].priceRaw, "12.30");
  assert.equal(
    fractional.products[0].offers[0].name,
    decoded.products[0].offers[0].name,
  );
  assert.equal(fractional.currentPage, decoded.currentPage);
  assert.throws(
    () => decodeCatalogPage(fractionalText.replace("12.30", "-1")),
    { code: "ProviderDecodeInvalid" },
  );
  assert.throws(
    () => decodeCatalogPage(fractionalText.replace("12.30", "1e2")),
    { code: "ProviderDecodeInvalid" },
  );
});

void test("decoder preserves only normalized discount facts and rejects incomplete rules", async () => {
  const page = JSON.parse(
    await readFile(
      new URL(
        "../../evidence/aroma-provider/2026-09-12-authenticated/catalog-page1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const product = page.data[0];
  const rule = {
    id: 200083,
    product_id: product.id,
    user_id: null,
    discount: 10,
    min_weight: 0,
    created_at: "2026-09-05T05:14:32.000000Z",
    updated_at: "2026-09-05T05:14:32.000000Z",
  };
  const decoded = decodeCatalogPage({
    ...page,
    data: [{ ...product, discount: [rule] }],
  });
  assert.deepEqual(decoded.products[0].discounts, [
    {
      discountRaw: "10",
      minimumWeightRaw: "0",
      providerCreatedAt: rule.created_at,
      providerUpdatedAt: rule.updated_at,
    },
  ]);
  for (const bad of [
    { ...rule, discount: 0 },
    { ...rule, min_weight: "-1" },
    { ...rule, created_at: "not-a-date" },
    { ...rule, updated_at: "2026-09-05T05:14:32Z", product_id: product.id + 1 },
  ])
    assert.throws(
      () =>
        decodeCatalogPage({ ...page, data: [{ ...product, discount: [bad] }] }),
      { code: "ProviderDecodeInvalid" },
    );
  assert.throws(
    () =>
      decodeCatalogPage({
        ...page,
        data: [{ ...product, discount: undefined }],
      }),
    { code: "ProviderDecodeInvalid" },
  );
});

void test("rejection shapes are recognized without claiming that a 422 had no effect", async () => {
  const duplicate = await capture("add-same-offer.json");
  const rejection = decodeProviderRejection(422, duplicate);
  assert.equal(rejection.effect, "unknown");
  assert.deepEqual(rejection.errorFieldNames, ["offer_id"]);
  assert.throws(
    () =>
      decodeProviderRejection(422, { error: "bad", errors: { offer_id: [4] } }),
    { code: "ProviderDecodeInvalid" },
  );
  assert.throws(() => decodeProviderRejection(422, {}), {
    code: "ProviderDecodeInvalid",
  });
});

void test("provider grind decoder accepts only bounded id/name entries", () => {
  assert.deepEqual(
    decodeProviderGrinds({
      data: [
        { id: 1, name: "Турка" },
        { id: "2", name: "Френч-пресс" },
      ],
    }),
    [
      { rawId: "1", displayName: "Турка" },
      { rawId: "2", displayName: "Френч-пресс" },
    ],
  );
  for (const invalid of [
    [],
    { data: [] },
    { data: [{ id: 1, title: "unsupported" }] },
    { data: [{ id: 0, name: "bad" }] },
    {
      data: [
        { id: 1, name: "x" },
        { id: 1, name: "duplicate" },
      ],
    },
  ]) {
    assert.throws(() => decodeProviderGrinds(invalid), {
      code: "ProviderDecodeInvalid",
    });
  }
});
