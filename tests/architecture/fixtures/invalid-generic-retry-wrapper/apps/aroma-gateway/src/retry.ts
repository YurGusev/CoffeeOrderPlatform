export function setCartQuantityWithRetry(
  gateway: Gateway,
  request: Request,
): Promise<Acknowledgement> {
  return withRetry(() => gateway.setQuantity(request));
}
