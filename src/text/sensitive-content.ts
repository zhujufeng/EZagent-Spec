const HIGH_CONFIDENCE_SENSITIVE_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:^|\D)1[3-9]\d{9}(?:\D|$)/u,
  /(?:^|\D)\d{17}[0-9Xx](?:\D|$)/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+/iu,
] as const;

export function containsSensitiveContent(value: string): boolean {
  return HIGH_CONFIDENCE_SENSITIVE_PATTERNS.some((pattern) => pattern.test(value));
}
