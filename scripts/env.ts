/** Loads .env if present (Node 22 built-in) and returns a required variable. */
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file — rely on the real environment
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}
