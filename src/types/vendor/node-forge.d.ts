// Extended type definitions for node-forge v1.4.0
// Covers pki, cipher, pkcs5, random, util APIs used in CertManager & PgCryptoShim

declare module 'node-forge' {
  namespace forge {
    // ── util ──────────────────────────────────────────────────────────
    namespace util {
      class ByteStringBuffer {
        constructor(bytes?: string, encoding?: string);
        putByte(byte: number): void;
        putBytes(bytes: string): void;
        getBytes(count?: number): string;
        length(): number;
        isEmpty(): boolean;
        toHex(): string;
        bytes(): string;
      }
      function createBuffer(bytes?: string, encoding?: string): ByteStringBuffer;
      function decode64(encoded: string): string;
      function encode64(bytes: string): string;
      function bytesToHex(bytes: string): string;
      function hexToBytes(hex: string): string;
      function bytesToString(bytes: string): string;
      function stringToBytes(str: string): string;
      function fillString(ch: string, count: number): string;
      function binaryToHex(binary: string): string;
    }

    // ── random ────────────────────────────────────────────────────────
    namespace random {
      function getBytesSync(count: number): string;
    }

    // ── asn1 ──────────────────────────────────────────────────────────
    namespace asn1 {
      interface Asn1Object {
        tagClass: number;
        type: number;
        constructed: boolean;
        composed: boolean;
        value: Asn1Object[] | number | string | util.ByteStringBuffer | null;
      }
      function fromDer(buf: util.ByteStringBuffer, capture?: unknown, options?: unknown): Asn1Object;
      function toDer(obj: Asn1Object): util.ByteStringBuffer;
    }

    // ── pki ───────────────────────────────────────────────────────────
    namespace pki {
      namespace rsa {
        interface KeyPair {
          publicKey: unknown;
          privateKey: unknown;
        }
        function generateKeyPair(bits?: number, e?: number): KeyPair;
      }

      interface Attribute {
        name: string;
        value: string;
        type?: string;
      }

      interface DistinguishedName {
        attributes: Attribute[];
      }

      interface Validity {
        notBefore: Date;
        notAfter: Date;
      }

      interface AltName {
        type: number; // 2=dNSName, 6=uniformResourceIdentifier
        value: string;
      }

      interface SubjectAltNameExtension {
        name: string;
        altNames: AltName[];
      }

      interface KeyUsageExtension {
        name: string;
        digitalSignature: boolean;
        nonRepudiation: boolean;
        keyEncipherment: boolean;
        dataEncipherment: boolean;
        keyAgreement: boolean;
        keyCertSign: boolean;
        cRLSign: boolean;
        encipherOnly: boolean;
        decipherOnly: boolean;
      }

      interface BasicConstraintsExtension {
        name: string;
        cA: boolean;
        pathLenConstraint?: number;
      }

      interface ExtendedKeyUsageExtension {
        name: string;
        usages: string[];
      }

      interface CertificateExtension {
        name: string;
        critical: boolean;
        value: unknown;
      }

      interface Certificate {
        version: number;
        serialNumber: string;
        validity: Validity;
        subject: DistinguishedName;
        issuer: DistinguishedName;
        publicKey: unknown;
        privateKey: unknown;
        extensions: CertificateExtension[];
        getExtension(name: string): any;
        verify(caCert: Certificate): boolean;
        setSubject(attrs: Attribute[]): void;
        setIssuer(attrs: Attribute[]): void;
        setExtensions(exts: Record<string, unknown>[]): void;
        sign(privateKey: unknown, md: md.MessageDigest): void;
      }

      interface CaStore {
        // opaque
      }

      function certificateFromPem(pem: string): Certificate;
      function certificateToPem(cert: Certificate): string;
      function createCertificate(): Certificate;
      function publicKeyFromPem(pem: string): unknown;
      function publicKeyToPem(key: unknown): string;
      function privateKeyFromPem(pem: string): unknown;
      function privateKeyToPem(key: unknown): string;
      function createCaStore(certs?: Certificate[]): CaStore;
      function verifyCertificateChain(caStore: CaStore, chain: Certificate[]): boolean;
      function pemToDer(pem: string): util.ByteStringBuffer;
      function certificationRequestFromPem(pem: string): unknown;
      function certificationRequestToPem(csr: unknown): string;
    }

    // ── cipher ────────────────────────────────────────────────────────
    namespace cipher {
      interface Mode {
        tag: util.ByteStringBuffer;
      }

      interface Cipher {
        start(params: { iv: util.ByteStringBuffer; additionalData?: string; tagLength?: number }): boolean;
        update(input: util.ByteStringBuffer): boolean;
        finish(): boolean;
        output: util.ByteStringBuffer;
        mode: Mode;
      }

      interface Decipher {
        start(params: { iv: util.ByteStringBuffer; tag?: util.ByteStringBuffer; additionalData?: string; tagLength?: number }): boolean;
        update(input: util.ByteStringBuffer): boolean;
        finish(): boolean;
        output: util.ByteStringBuffer;
      }

      type Algorithm = 'AES-ECB' | 'AES-CBC' | 'AES-CFB' | 'AES-OFB' | 'AES-CTR' | 'AES-GCM';

      function createCipher(algorithm: Algorithm, key: util.ByteStringBuffer): Cipher;
      function createDecipher(algorithm: Algorithm, key: util.ByteStringBuffer): Decipher;
    }

    // ── md / sha256 ───────────────────────────────────────────────────
    namespace md {
      interface MessageDigest {
        update(data: string, encoding?: string): void;
        digest(): util.ByteStringBuffer;
      }

      function create(hash: string): MessageDigest;
      namespace sha256 {
        function create(): MessageDigest;
      }
    }

    // ── pkcs5 ─────────────────────────────────────────────────────────
    namespace pkcs5 {
      function pbkdf2(password: string, salt: string, iterations: number, keyLength: number, md?: string): string;
    }

    // ── hmac ──────────────────────────────────────────────────────────
    namespace hmac {
      function create(): any;
    }
  }

  export = forge;
}