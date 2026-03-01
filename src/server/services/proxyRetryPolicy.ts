const MODEL_UNSUPPORTED_PATTERNS: RegExp[] = [
  /当前\s*api\s*不支持所选模型/i,
  /不支持所选模型/i,
  /不支持.*模型/i,
  /模型.*不支持/i,
  /unsupported\s+model/i,
  /model\s+not\s+supported/i,
  /does\s+not\s+support(?:\s+the)?\s+model/i,
  /model.*does\s+not\s+exist/i,
  /no\s+such\s+model/i,
  /unknown\s+model/i,
  /invalid\s+model/i,
  /model[_\s-]?not[_\s-]?found/i,
  /you\s+do\s+not\s+have\s+access\s+to\s+the\s+model/i,
];

function isModelUnsupportedErrorMessage(rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return MODEL_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

export function shouldRetryProxyRequest(status: number, upstreamErrorText?: string | null): boolean {
  if (status >= 400) return true;
  if (!upstreamErrorText) return false;
  return isModelUnsupportedErrorMessage(upstreamErrorText);
}
