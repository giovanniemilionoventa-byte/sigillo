/**
 * The two ways a request to the signer can fail, kept apart because they mean
 * different things. Unavailable: no answer (down, restarting, too slow, not a
 * sigillo signer), and trying again later may well work. Refused: the signer
 * answered, and said no — for a receipt, most often because it is not the
 * next one of the chain the signer remembers.
 */

export class SignerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerUnavailableError";
  }
}

/** The `code` of a refusal, as the signer's protocol names it (apps/signer/src/signer.ts). */
export type SignerRefusalCode = "malformed" | "version" | "invalid" | "sequence" | "clock" | "unknown_system";

const CODES: readonly string[] = ["malformed", "version", "invalid", "sequence", "clock", "unknown_system"];

export class SignerRefusedError extends Error {
  constructor(
    readonly code: SignerRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "SignerRefusedError";
  }
}

/** The error for a refusal the signer sent, whatever it sent as its code. */
export function refusalFrom(code: unknown, error: unknown): SignerRefusedError {
  const known = typeof code === "string" && CODES.includes(code) ? (code as SignerRefusalCode) : "malformed";
  return new SignerRefusedError(known, `the signer refused: ${String(error)}`);
}
