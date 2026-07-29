// Magic-byte file sniffing. Pure and dependency-free so the SAME logic runs
// client-side (before upload) and server-side (before the model call).
// Extension is advisory only; bytes decide.

export type SniffKind = 'pdf' | 'docx' | 'jpeg' | 'png' | 'unknown';

export const SNIFF_BYTES_NEEDED = 8;

export function sniffBytes(bytes: Uint8Array): SniffKind {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf'; // %PDF
  }
  // DOCX is a zip container (PK\x03\x04). The only zip-based format we accept
  // is DOCX; a plain .zip renamed to .docx will fail at mammoth and route to
  // the unreadable state, which is the honest outcome.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'docx';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  return 'unknown';
}

export const isPhoto = (kind: SniffKind): boolean => kind === 'jpeg' || kind === 'png';
export const isDoc = (kind: SniffKind): boolean => kind === 'pdf' || kind === 'docx';

export const contentTypeFor = (kind: SniffKind): string =>
  kind === 'pdf'
    ? 'application/pdf'
    : kind === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : kind === 'jpeg'
        ? 'image/jpeg'
        : kind === 'png'
          ? 'image/png'
          : 'application/octet-stream';

export const ACCEPTED_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
];
