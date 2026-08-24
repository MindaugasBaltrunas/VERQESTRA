import { createHash, generateKeyPairSync, sign } from "node:crypto";

/**
 * Self-signed X.509 certificates for host bootstrap tests, assembled as DER by
 * hand.
 *
 * There is no other way to get one here: `node:crypto` can generate keys but
 * cannot sign a certificate, shelling out to `openssl` would add a third
 * process-spawning file and break the architecture boundary test, and a
 * committed test key is a private key in the repository — the exact thing this
 * package's threat model forbids.
 *
 * Every key created here is generated at the start of a test run and is
 * unreachable once the run ends: nothing is written to disk and nothing is
 * reused across runs.
 */

/** Ed25519 (RFC 8410): the signature algorithm identifier carries no parameters. */
const ED25519_OID = "1.3.101.112";
const COMMON_NAME_OID = "2.5.4.3";
const SUBJECT_ALT_NAME_OID = "2.5.29.17";

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSequence(...parts: Buffer[]): Buffer {
  return derTlv(0x30, Buffer.concat(parts));
}

function derSet(content: Buffer): Buffer {
  return derTlv(0x31, content);
}

function derInteger(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = Math.trunc(value);
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  // DER integers are two's complement, so a leading bit set would read as a
  // negative serial number.
  if ((bytes[0] ?? 0) >= 0x80) bytes.unshift(0);
  return derTlv(0x02, Buffer.from(bytes));
}

function derOid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map((part) => Number.parseInt(part, 10));
  const bytes: number[] = [first * 40 + second];
  for (const component of rest) {
    const chunk: number[] = [component & 0x7f];
    let remaining = Math.floor(component / 128);
    while (remaining > 0) {
      chunk.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...chunk);
  }
  return derTlv(0x06, Buffer.from(bytes));
}

function derBitString(content: Buffer): Buffer {
  return derTlv(0x03, Buffer.concat([Buffer.from([0x00]), content]));
}

function derOctetString(content: Buffer): Buffer {
  return derTlv(0x04, content);
}

function derUtf8(text: string): Buffer {
  return derTlv(0x0c, Buffer.from(text, "utf8"));
}

function derContext(tag: number, content: Buffer, constructed: boolean): Buffer {
  return derTlv((constructed ? 0xa0 : 0x80) | tag, content);
}

function derName(commonName: string): Buffer {
  return derSequence(derSet(derSequence(derOid(COMMON_NAME_OID), derUtf8(commonName))));
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function derTime(value: Date): Buffer {
  const body = [
    twoDigits(value.getUTCMonth() + 1),
    twoDigits(value.getUTCDate()),
    twoDigits(value.getUTCHours()),
    twoDigits(value.getUTCMinutes()),
    twoDigits(value.getUTCSeconds()),
  ].join("");
  const year = value.getUTCFullYear();
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050 on.
  return year < 2050
    ? derTlv(0x17, Buffer.from(`${twoDigits(year % 100)}${body}Z`, "ascii"))
    : derTlv(0x18, Buffer.from(`${String(year).padStart(4, "0")}${body}Z`, "ascii"));
}

/** Raw SAN address bytes: four for IPv4, sixteen for IPv6. */
function ipAddressBytes(value: string): Buffer {
  if (!value.includes(":")) {
    const octets = value.split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      throw new Error(`Not an IPv4 address: ${value}`);
    }
    return Buffer.from(octets);
  }
  const compressed = value.includes("::");
  const [headText = "", tailText = ""] = value.split("::");
  const toWords = (text: string): number[] =>
    text.length === 0 ? [] : text.split(":").map((group) => Number.parseInt(group, 16));
  const head = toWords(headText);
  const tail = compressed ? toWords(tailText) : [];
  const words = compressed
    ? [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail]
    : head;
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    throw new Error(`Not an IPv6 address: ${value}`);
  }
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}

function derSubjectAltName(
  dnsSans: readonly string[],
  ipSans: readonly string[],
): Buffer | undefined {
  if (dnsSans.length === 0 && ipSans.length === 0) return undefined;
  const generalNames = derSequence(
    ...dnsSans.map((name) => derContext(2, Buffer.from(name, "ascii"), false)),
    ...ipSans.map((address) => derContext(7, ipAddressBytes(address), false)),
  );
  return derSequence(derOid(SUBJECT_ALT_NAME_OID), derOctetString(generalNames));
}

function toPem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function createTestCertificate(
  input: Readonly<{
    commonName: string;
    ipSans?: readonly string[];
    dnsSans?: readonly string[];
    notBefore: Date;
    notAfter: Date;
  }>,
): { certificatePem: string; privateKeyPem: string; derSha256Hex: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const algorithm = derSequence(derOid(ED25519_OID));
  const name = derName(input.commonName);
  const subjectPublicKeyInfo = publicKey.export({ format: "der", type: "spki" });
  const extension = derSubjectAltName(input.dnsSans ?? [], input.ipSans ?? []);

  const tbsParts = [
    derContext(0, derInteger(2), true),
    derInteger(Date.now()),
    algorithm,
    name,
    derSequence(derTime(input.notBefore), derTime(input.notAfter)),
    // Self-signed: the issuer is the subject, which is what the bootstrap
    // treats as `selfSigned`.
    name,
    subjectPublicKeyInfo,
  ];
  if (extension) {
    tbsParts.push(derContext(3, derSequence(extension), true));
  }
  const tbsCertificate = derSequence(...tbsParts);
  // Ed25519 signs the message directly, so the digest algorithm is `null`.
  const signature = sign(null, tbsCertificate, privateKey);
  const der = derSequence(tbsCertificate, algorithm, derBitString(signature));

  const exportedKey = privateKey.export({ format: "pem", type: "pkcs8" });
  return {
    certificatePem: toPem("CERTIFICATE", der),
    privateKeyPem: typeof exportedKey === "string" ? exportedKey : exportedKey.toString("utf8"),
    derSha256Hex: createHash("sha256").update(der).digest("hex"),
  };
}
