import { isNullOrWhiteSpace } from '../domain/text';
import { USER_ROLES, type UserRole } from '../domain/roles';
import { statusProblem, validationProblem } from './problems';

/**
 * JSON request binding and validation with the semantics of the ASP.NET Core API (`[ApiController]` + System.Text.Json
 * web defaults + DataAnnotations), so the same requests succeed or fail with the same status and error keys:
 * - only JSON content types are accepted (otherwise 415);
 * - property names are case-insensitive, unknown properties are ignored;
 * - a missing property takes its .NET default (null, 0, false); numbers may also be sent as numeric strings;
 * - a wrongly typed value stops binding: errors `request` and `$.<property>` (400);
 * - then the attributes: [Required], [MaxLength], [Range], with the .NET messages, keyed by the C# property name.
 */
/** `object`: a nested JSON object passed through as-is, for a use case to validate (Workers-only endpoints). */
export type PropertyKind = 'string' | 'int' | 'decimal' | 'bool' | 'role' | 'object';

export interface PropertySpec {
  /** The C# property name (PascalCase); the JSON name is its camelCase form. */
  name: string;
  kind: PropertyKind;
  required?: boolean;
  maxLength?: number;
  /** [Range(min, max)] with the bounds as written in C# (used in the message). */
  range?: { min: number; max: number; minText: string; maxText: string };
}

export interface RequestSchema {
  /** Full .NET type name, used in conversion error messages. */
  typeName: string;
  properties: PropertySpec[];
}

/** A role sent as a name (any case) or as the enum's number; numbers that are not a role stay as `invalid`. */
export type RoleValue = UserRole | 'invalid';

type Bound = Record<string, string | number | boolean | null | RoleValue | Record<string, unknown> | undefined>;

export type BindResult<T> = { ok: true; value: T } | { ok: false; response: Response };

const REQUEST_REQUIRED = 'The request field is required.';
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

export async function bindJson<T>(request: Request, schema: RequestSchema, traceId: string): Promise<BindResult<T>> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return { ok: false, response: statusProblem(415, traceId, true) };
  }

  const text = await request.text();
  let root: unknown = null;
  if (text.length > 0) {
    try {
      root = JSON.parse(text);
    } catch {
      return fail({ $: ['The JSON request body is malformed. Path: $.'], request: [REQUEST_REQUIRED] }, traceId);
    }
  }

  if (root === null) {
    // An empty body and a JSON `null` are both "no body" for the input formatter.
    return fail({ '': ['A non-empty request body is required.'], request: [REQUEST_REQUIRED] }, traceId);
  }

  if (typeof root !== 'object' || Array.isArray(root)) {
    return fail({ $: [conversionMessage(schema, '$')], request: [REQUEST_REQUIRED] }, traceId);
  }

  // Case-insensitive property lookup; the last duplicate wins, as in System.Text.Json.
  const supplied = new Map<string, { key: string; value: unknown }>();
  for (const [key, value] of Object.entries(root)) {
    supplied.set(key.toLowerCase(), { key, value });
  }

  const bound: Bound = {};
  for (const property of schema.properties) {
    const entry = supplied.get(property.name.toLowerCase());
    const converted = entry === undefined ? defaultValue(property.kind) : convert(property.kind, entry.value);
    if (converted === CONVERSION_FAILED) {
      const path = `$.${entry!.key}`;
      return fail({ request: [REQUEST_REQUIRED], [path]: [conversionMessage(schema, path)] }, traceId);
    }

    bound[camelCase(property.name)] = converted;
  }

  const errors: Record<string, string[]> = {};
  for (const property of schema.properties) {
    const messages = validate(property, bound[camelCase(property.name)]);
    if (messages.length > 0) errors[property.name] = messages;
  }

  return Object.keys(errors).length > 0 ? fail(errors, traceId) : { ok: true, value: bound as T };
}

function fail(errors: Record<string, string[]>, traceId: string): { ok: false; response: Response } {
  return { ok: false, response: validationProblem(errors, traceId) };
}

function isJsonContentType(header: string | null): boolean {
  const mediaType = header?.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType === 'text/json' || /^application\/[^/]+\+json$/.test(mediaType);
}

const CONVERSION_FAILED = Symbol('conversion failed');

function defaultValue(kind: PropertyKind) {
  switch (kind) {
    case 'string':
      return null;
    case 'int':
    case 'decimal':
      return 0;
    case 'bool':
      return false;
    case 'role':
      return undefined; // see validate(): a role must be sent
    case 'object':
      return null;
  }
}

function convert(kind: PropertyKind, value: unknown): Bound[string] | typeof CONVERSION_FAILED {
  switch (kind) {
    case 'string':
      return typeof value === 'string' || value === null ? value : CONVERSION_FAILED;
    case 'bool':
      return typeof value === 'boolean' ? value : CONVERSION_FAILED;
    case 'int': {
      const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
      return typeof number === 'number' && Number.isInteger(number) && number >= INT32_MIN && number <= INT32_MAX
        ? number
        : CONVERSION_FAILED;
    }
    case 'decimal': {
      const number = typeof value === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value) ? Number(value) : value;
      return typeof number === 'number' && Number.isFinite(number) ? number : CONVERSION_FAILED;
    }
    case 'role': {
      if (typeof value === 'string') {
        const role = USER_ROLES.find((r) => r.toLowerCase() === value.trim().toLowerCase());
        if (role) return role;
        return /^-?\d+$/.test(value.trim()) ? roleFromNumber(Number(value)) : CONVERSION_FAILED;
      }

      return typeof value === 'number' && Number.isInteger(value) ? roleFromNumber(value) : CONVERSION_FAILED;
    }
    case 'object':
      return value === null || (typeof value === 'object' && !Array.isArray(value))
        ? (value as Record<string, unknown> | null)
        : CONVERSION_FAILED;
  }
}

/** UserRole's numeric values in C#: Admin = 0, HR = 1, Trainee = 2, Employee = 3. */
function roleFromNumber(value: number): RoleValue {
  return USER_ROLES[value] ?? 'invalid';
}

function validate(property: PropertySpec, value: Bound[string]): string[] {
  const messages: string[] = [];
  const missingRole = property.kind === 'role' && value === undefined;
  const missingObject = property.required && property.kind === 'object' && value === null;
  if (
    (property.required && property.kind === 'string' && isNullOrWhiteSpace(value as string | null)) ||
    missingRole ||
    missingObject
  ) {
    // A missing role is rejected (C# would bind default(UserRole) = Admin). See README.md, "Deliberate differences".
    messages.push(`The ${property.name} field is required.`);
    return messages;
  }

  if (property.maxLength !== undefined && typeof value === 'string' && value.length > property.maxLength) {
    messages.push(
      `The field ${property.name} must be a string or array type with a maximum length of '${property.maxLength}'.`,
    );
  }

  const range = property.range;
  if (range && typeof value === 'number' && (value < range.min || value > range.max)) {
    messages.push(`The field ${property.name} must be between ${range.minText} and ${range.maxText}.`);
  }

  return messages;
}

function conversionMessage(schema: RequestSchema, path: string): string {
  return `The JSON value could not be converted to ${schema.typeName}. Path: ${path}.`;
}

function camelCase(name: string): string {
  return name[0]!.toLowerCase() + name.slice(1);
}
