import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native and database modules stay on the server and are not bundled.
  serverExternalPackages: ["@node-rs/argon2", "pg"],
  poweredByHeader: false,
  // Browser tests run their own dev server next to a developer's (scripts/e2e-server.ts).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // "/" goes to the browser's preferred language: Arabic if it is listed first, otherwise English.
  async redirects() {
    return [
      {
        source: "/",
        has: [{ type: "header", key: "accept-language", value: "(?<lang>ar)(?:[-;,].*)?" }],
        destination: "/ar/login",
        permanent: false,
      },
      { source: "/", destination: "/en/login", permanent: false },
    ];
  },
};

export default nextConfig;
