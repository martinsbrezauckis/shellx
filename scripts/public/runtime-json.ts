export function parseJsonValue(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`);
  }
}

export function requireJsonObject(value: unknown, label: string): object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function readJsonProperty(value: unknown, key: string, label: string): unknown {
  return Reflect.get(requireJsonObject(value, label), key);
}

export function requireStringProperty(value: unknown, key: string, label: string): string {
  const property = readJsonProperty(value, key, label);
  if (typeof property !== "string" || !property.trim()) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return property;
}

export function optionalStringProperty(value: unknown, key: string, label: string): string | undefined {
  const property = readJsonProperty(value, key, label);
  if (property === undefined || property === null) return undefined;
  if (typeof property !== "string") throw new Error(`${label}.${key} must be a string`);
  return property;
}

export function requireIntegerProperty(value: unknown, key: string, label: string): number {
  const property = readJsonProperty(value, key, label);
  if (!Number.isInteger(property)) throw new Error(`${label}.${key} must be an integer`);
  return Number(property);
}

export function requireBooleanProperty(value: unknown, key: string, label: string): boolean {
  const property = readJsonProperty(value, key, label);
  if (typeof property !== "boolean") throw new Error(`${label}.${key} must be a boolean`);
  return property;
}

export function optionalArrayProperty(value: unknown, key: string, label: string): unknown[] | undefined {
  const property = readJsonProperty(value, key, label);
  if (property === undefined || property === null) return undefined;
  if (!Array.isArray(property)) throw new Error(`${label}.${key} must be an array`);
  return property;
}
