# Validation fingerprint and stale proof

`InvoiceValidationFingerprint` включает:

- PDF artifact hash;
- parsed canonical content hash;
- selected Checkout/Order refs;
- allocation manifest hash/version;
- validation policy version.

Commit принимает fingerprint и expected invoice-operation version. Если любой dependency изменился, `409 invoice_validation_stale` и требуется повторная validation.

Fingerprint comparison constant-time для security-sensitive opaque proof.
