export const queryKeys = {
  catalogSearch: (
    input: Readonly<{
      availability: string;
      cursor?: string;
      orderRef: string;
      q: string;
      supplierDiscountBasisPoints?: "1000" | "3500";
    }>,
  ) => ["catalog", "search", { ...input, limit: 20 }] as const,
  customersSearch: (input: Readonly<{ cursor?: string; q: string }>) =>
    ["customers", "search", { ...input, limit: 20 }] as const,
  orderDetail: (orderRef: string) => ["orders", "detail", orderRef] as const,
};
