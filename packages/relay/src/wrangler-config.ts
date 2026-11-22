export interface WranglerConfigOptions {
  /** Name of the Worker in the user's account. Every tunnel is a preview of it. */
  workerName: string;
  /** The bundled Worker file next to the config. */
  main?: string;
  compatibilityDate?: string;
}

/**
 * The wrangler.toml that `wrangler preview` needs. Previews do not inherit production settings, so the
 * Durable Object binding is repeated under [previews] (without it the Worker fails with error 1101).
 */
export function renderWranglerConfig({
  workerName,
  main = 'worker.js',
  compatibilityDate = '2025-01-01',
}: WranglerConfigOptions): string {
  return `name = "${workerName}"
main = "${main}"
compatibility_date = "${compatibilityDate}"

[durable_objects]
bindings = [{ name = "RELAY", class_name = "Relay" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Relay"]

# Previews do not inherit production settings: repeat the Durable Object binding here
[previews]

[previews.durable_objects]
bindings = [{ name = "RELAY", class_name = "Relay" }]
`;
}
