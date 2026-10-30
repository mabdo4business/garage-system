import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native and database modules stay on the server and are not bundled.
  serverExternalPackages: ["@node-rs/argon2", "pg"],
  poweredByHeader: false,
  // Browser tests run their own dev server next to a developer's (scripts/e2e-server.ts).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Customer link pages (I2-03a, PRD v0.2 §6.4): never indexed, and the token in the address never leaves in a Referer
  // header. They are never cached either: the pages are dynamic (Next.js sends no-store itself and would override a
  // Cache-Control set here) and the photo route sets its own.
  async headers() {
    const linkHeaders = [
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ];
    return [
      { source: "/:locale(ar|en)/c/:token", headers: linkHeaders },
      { source: "/c/:path*", headers: linkHeaders },
    ];
  },
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
