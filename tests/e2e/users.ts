/** Test users and port shared by scripts/e2e-server.ts (no Playwright import) and the specs. */
export const E2E_PORT = 5002;
export const E2E_PASSWORD = "e2e-only-password-not-secret";
export const E2E_USERS = {
  advisor: { username: "e2e.advisor", displayName: "Amal Advisor", role: "service_advisor" },
  technician: { username: "e2e.tech", displayName: "Tariq Technician", role: "technician" },
} as const;
