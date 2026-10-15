import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native and database modules stay on the server and are not bundled.
  serverExternalPackages: ["@node-rs/argon2", "pg"],
  poweredByHeader: false,
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
