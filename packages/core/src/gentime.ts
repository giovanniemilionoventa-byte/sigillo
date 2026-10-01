/**
 * The time an RFC 3161 token attests (genTime), read from the token's own
 * bytes.
 *
 * genTime, signed by the authority, is the evidence of when a checkpoint
 * existed; the time the server received the token (`obtained_at`) is only the
 * server's clock (review point 8). The server and the verifier both read it
 * here, so the PDF, VERIFY.md, the web view and `sigillo-verify` cannot
 * disagree about it. The verifier also reads it through openssl and fails a
 * token on which the two readings differ; they are compared on real tokens in
 * apps/server/test/gentime.test.ts.
 *
 * Only the path to genTime is walked:
 *
 *   TimeStampResp  ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo }
 *   ContentInfo    ::= SEQUENCE { contentType OID, content [0] EXPLICIT SignedData }
 *   SignedData     ::= SEQUENCE { version, digestAlgorithms SET,
 *                                 encapContentInfo SEQUENCE { eContentType OID,
 *                                   eContent [0] EXPLICIT OCTET STRING (TSTInfo) }, ... }
 *   TSTInfo        ::= SEQUENCE { version, policy, messageImprint, serialNumber,
 *                                 genTime GeneralizedTime, ... }
 *
 * A token that does not have this shape, has bytes after its end, or carries a
 * time that is not a real UTC date gives undefined, never a guess. This reads
 * the time; it does not check the token's signature (the verifier does, with
 * openssl). Pure: no disk, no network, no clock.
 */

interface Element {
  tag: number;
  /** Where the contents start and end, in the whole buffer. */
  start: number;
  end: number;
}

function element(bytes: Uint8Array, offset: number, limit: number): Element | undefined {
  if (offset + 2 > limit) return undefined;
  const tag = bytes[offset] ?? 0;
  let length = bytes[offset + 1] ?? 0;
  let start = offset + 2;
  if ((length & 0x80) !== 0) {
    const octets = length & 0x7f;
    if (octets === 0 || octets > 4 || start + octets > limit) return undefined;
    length = 0;
    for (let index = 0; index < octets; index += 1) length = length * 256 + (bytes[start + index] ?? 0);
    start += octets;
  }
  const end = start + length;
  return end > limit ? undefined : { tag, start, end };
}

/** The children of a constructed element, in order. */
function children(bytes: Uint8Array, parent: Element): Element[] {
  const found: Element[] = [];
  for (let offset = parent.start; offset < parent.end; ) {
    const child = element(bytes, offset, parent.end);
    if (child === undefined) return [];
    found.push(child);
    offset = child.end;
  }
  return found;
}

const SEQUENCE = 0x30;
const OID = 0x06;
const EXPLICIT_0 = 0xa0;
const OCTET_STRING = 0x04;
const GENERALIZED_TIME = 0x18;

export function genTimeOfToken(token: Uint8Array): string | undefined {
  const outer = element(token, 0, token.length);
  if (outer?.tag !== SEQUENCE || outer.end !== token.length) return undefined;

  // A TimeStampResp starts with a status SEQUENCE; a bare token with an OID.
  let contentInfo: Element | undefined = outer;
  const [first, second] = children(token, outer);
  if (first?.tag === SEQUENCE) contentInfo = second;
  if (contentInfo?.tag !== SEQUENCE) return undefined;

  const [contentType, content] = children(token, contentInfo);
  if (contentType?.tag !== OID || content?.tag !== EXPLICIT_0) return undefined;
  const [signedData] = children(token, content);
  if (signedData?.tag !== SEQUENCE) return undefined;
  const encap = children(token, signedData)[2];
  if (encap?.tag !== SEQUENCE) return undefined;
  const eContent = children(token, encap)[1];
  if (eContent?.tag !== EXPLICIT_0) return undefined;
  const [octets] = children(token, eContent);
  if (octets?.tag !== OCTET_STRING) return undefined;
  const tstInfo = element(token, octets.start, octets.end);
  if (tstInfo?.tag !== SEQUENCE) return undefined;
  const genTime = children(token, tstInfo)[4];
  if (genTime?.tag !== GENERALIZED_TIME) return undefined;

  const value = new TextDecoder().decode(token.subarray(genTime.start, genTime.end));
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hours, minutes, seconds, fraction] = match;
  const millis = Math.floor(Number(`0${fraction ?? ""}`) * 1000);
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds), millis),
  );
  // Date.UTC rolls 30 February over into March; a real date reads back the same.
  const iso = date.toISOString();
  return iso.slice(0, 19) === `${year}-${month}-${day}T${hours}:${minutes}:${seconds}` ? iso : undefined;
}
