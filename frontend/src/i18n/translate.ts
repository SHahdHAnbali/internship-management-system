export type Messages = { [key: string]: string | Messages };
export type Params = Record<string, string | number>;

/** Looks up a dot-separated key ("admin.fields.title") and fills {{param}} placeholders. Unknown keys return the key. */
export function translate(messages: Messages | null, key: string, params?: Params): string {
  let node: string | Messages | undefined = messages ?? undefined;
  for (const part of key.split('.')) {
    node = typeof node === 'object' ? node[part] : undefined;
  }

  const text = typeof node === 'string' ? node : key;
  return params
    ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(params[name] ?? ''))
    : text;
}
