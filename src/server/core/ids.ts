/** Any syntactically valid UUID — what PostgreSQL's uuid type accepts in canonical form. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value can be compared to a uuid column without a 22P02 cast error. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
