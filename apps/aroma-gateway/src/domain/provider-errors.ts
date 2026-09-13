export type ProviderErrorCode =
  | "ProviderUnavailable"
  | "ProviderAuthenticationFailed"
  | "ProviderAuthorizationFailed"
  | "ProviderProtocolViolation"
  | "ProviderResponseTooLarge"
  | "ProviderReadIncomplete"
  | "ProviderDecodeIncomplete"
  | "ProviderDecodeInvalid"
  | "ProviderSessionUnavailable"
  | "ProviderCartMappingMissing"
  | "ProviderCartMappingAmbiguous"
  | "ProviderCancelled";

/**
 * Deliberately contains no provider body, URL supplied by a caller, cookie, or
 * credential. `statusCode` is safe transport metadata only.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly responseBytesReceived: boolean;
  readonly statusCode: number | undefined;

  constructor(code: ProviderErrorCode, responseBytesReceived = false, statusCode?: number) {
    super(code);
    this.name = "ProviderError";
    this.code = code;
    this.responseBytesReceived = responseBytesReceived;
    this.statusCode = statusCode;
  }
}
