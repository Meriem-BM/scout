import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.SCOUT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: [
    "@scout/domain",
    "@scout/database",
    "@scout/integrations",
  ],
  serverExternalPackages: ["postgres"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://auth.privy.io https://assets.privy.io https://www.gstatic.com; font-src 'self'; connect-src 'self' https: wss: http://127.0.0.1:54321 http://localhost:54321; frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
          },
        ],
      },
    ];
  },
};

export default config;
