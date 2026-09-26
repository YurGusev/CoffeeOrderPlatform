import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {
  calculatePricingLine,
  encodeMinor,
  parseCanonicalMinor,
  parseQuantity,
  sumLineTotals,
} from "../../apps/pricing-service/dist/domain/pricing-formula.js";

const line = (overrides = {}) => calculatePricingLine({
  quantity: "1",
  supplierUnitMinor: "100",
  markupBasisPoints: 0,
  minimumMarginMinor: 0n,
  ...overrides,
});

void test("zero markup and minimum margin preserve supplier unit price", () => {
  assert.deepEqual(line(), {quantity: "1", quantityMilli: 1000n, unitMinor: 100n, lineTotalMinor: 100n});
  assert.equal(encodeMinor(line().lineTotalMinor), "100");
  assert.equal(encodeMinor(0n), "0");
});

void test("quantity parsing uses exact milli and canonical decimal wire", () => {
  for (const [quantity, canonical, milli] of [
    ["0.001", "0.001", 1n], ["1", "1", 1000n], ["1.200", "1.2", 1200n],
    ["2.500", "2.5", 2500n], ["999999.999", "999999.999", 999999999n],
  ]) {
    assert.deepEqual(parseQuantity(quantity), {quantity: canonical, quantityMilli: milli});
  }
});

void test("markup rounds the unit up before multiplying fractional quantity", () => {
  assert.deepEqual(line({supplierUnitMinor: "1", markupBasisPoints: 1, quantity: "0.001"}), {
    quantity: "0.001", quantityMilli: 1n, unitMinor: 2n, lineTotalMinor: 1n,
  });
  assert.equal(line({supplierUnitMinor: "100", markupBasisPoints: 3000, quantity: "2.500"}).lineTotalMinor, 325n);
  assert.equal(line({supplierUnitMinor: "1", quantity: "1.001"}).lineTotalMinor, 2n);
});

void test("minimum margin wins over markup when higher", () => {
  assert.equal(line({supplierUnitMinor: "100", markupBasisPoints: 3000, minimumMarginMinor: 40n}).unitMinor, 140n);
  assert.equal(line({supplierUnitMinor: "0", minimumMarginMinor: 1n, quantity: "0.001"}).lineTotalMinor, 1n);
});

void test("supplier money is canonical nonnegative decimal; quantity rejects locale and invalid range", () => {
  for (const bad of ["", "00", "01", "-1", "+1", "1.0", " 1", "1e3", "1,000", "١", 1]) {
    assert.throws(() => parseCanonicalMinor(bad));
  }
  assert.equal(parseCanonicalMinor("0"), 0n);
  assert.equal(parseCanonicalMinor("9223372036854775807"), 9223372036854775807n);
  for (const bad of ["0", "0.000", "0.0000", "0.00", "0.0010", "1.", "01", "0001", "1000000", "999999.9999", "1,2", "1e2", " 1", "١", 1]) {
    assert.throws(() => parseQuantity(bad));
  }
});

void test("invalid policy values and signed DB bigint overflow are rejected", () => {
  for (const markupBasisPoints of [-1, 100001, 0.1, NaN, Infinity, "3000"]) {
    assert.throws(() => line({markupBasisPoints}));
  }
  assert.throws(() => line({minimumMarginMinor: -1n}));
  assert.throws(() => line({minimumMarginMinor: 1}));
  assert.throws(() => parseCanonicalMinor("9223372036854775808"));
  assert.throws(() => line({supplierUnitMinor: "9223372036854775807", markupBasisPoints: 1}));
  assert.throws(() => line({supplierUnitMinor: "9223372036854775807", quantity: "1.001"}));
  assert.equal(encodeMinor(9223372036854775807n), "9223372036854775807");
  assert.throws(() => encodeMinor(9223372036854775808n));
});

void test("quote totals sum integer line totals and reject sum overflow", () => {
  assert.equal(sumLineTotals([line({quantity: "0.001"}), line({quantity: "2"})]), 201n);
  assert.equal(sumLineTotals([]), 0n);
  assert.throws(() => sumLineTotals([line({supplierUnitMinor: "9223372036854775807"}), line({supplierUnitMinor: "1"})]));
});

void test("a bounded sweep checks bigint rounding and total invariants", () => {
  for (let supplier = 0n; supplier < 40n; supplier += 1n) {
    for (const markupBasisPoints of [0, 1, 2999, 3000, 100000]) {
      for (const quantity of ["0.001", "0.999", "1", "1.001", "999999.999"]) {
        const result = line({supplierUnitMinor: supplier.toString(), markupBasisPoints, quantity, minimumMarginMinor: 2n});
        const markup = (supplier * (10000n + BigInt(markupBasisPoints)) + 9999n) / 10000n;
        const minimum = supplier + 2n;
        assert.equal(result.unitMinor, markup > minimum ? markup : minimum);
        assert.equal(result.lineTotalMinor * 1000n >= result.unitMinor * result.quantityMilli, true);
        assert.equal(result.lineTotalMinor * 1000n - result.unitMinor * result.quantityMilli < 1000n, true);
        assert.equal(sumLineTotals([result, result]), result.lineTotalMinor * 2n);
      }
    }
  }
});

void test("canonical calculation survives a fresh process under different locales/timezones", () => {
  const moduleUrl = new URL("../../apps/pricing-service/dist/domain/pricing-formula.js", import.meta.url).href;
  const expression = `import {calculatePricingLine,encodeMinor} from ${JSON.stringify(moduleUrl)}; const line = calculatePricingLine({quantity:"0.125",supplierUnitMinor:"123456789012345",markupBasisPoints:3000,minimumMarginMinor:0n}); console.log(JSON.stringify({quantity:line.quantity,unitMinor:encodeMinor(line.unitMinor),lineTotalMinor:encodeMinor(line.lineTotalMinor)}))`;
  const run = (lang, timezone) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", expression], {
      encoding: "utf8", env: {...process.env, LANG: lang, LC_ALL: lang, TZ: timezone},
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(run("en_US.UTF-8", "UTC"), run("fr_FR.UTF-8", "Pacific/Honolulu"));
});
