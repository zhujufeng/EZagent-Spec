export const CLI_JSON_INPUT_MAX_BYTES = 65_536;

export interface JsonInputSource {
  readonly chunks: AsyncIterable<Uint8Array | string>;
}

export async function readBoundedJsonInput(source: JsonInputSource): Promise<unknown> {
  if (source === null || typeof source !== "object" || source.chunks === undefined) {
    throw new TypeError("JSON stdin source is invalid");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source.chunks) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (buffer.byteLength > CLI_JSON_INPUT_MAX_BYTES - bytes) {
      throw new TypeError(`JSON stdin exceeds ${CLI_JSON_INPUT_MAX_BYTES} bytes`);
    }
    bytes += buffer.byteLength;
    chunks.push(buffer);
  }
  if (bytes === 0) throw new TypeError("JSON stdin is empty");
  const input = Buffer.concat(chunks, bytes);
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    throw new TypeError("JSON stdin must not contain a UTF-8 BOM");
  }
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error: unknown) {
    throw new TypeError("JSON stdin must contain valid UTF-8", { cause: error });
  }
  if (sourceText.includes("\0")) throw new TypeError("JSON stdin must not contain NUL");
  const document = sourceText.replace(/^[\x20\t\r\n]*/u, "").replace(/[\x20\t\r\n]*$/u, "");
  if (document.length === 0) throw new TypeError("JSON stdin is empty");
  let value: unknown;
  try {
    value = JSON.parse(document) as unknown;
  } catch (error: unknown) {
    throw new TypeError("JSON stdin must contain exactly one JSON document", { cause: error });
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError("JSON stdin root must not be a primitive");
  }
  return value;
}
