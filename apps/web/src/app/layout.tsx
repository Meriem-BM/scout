import { GeistMono } from "geist/font/mono";

import { scoutText } from "@/features/communication/fonts";
import { Providers } from "@/features/workspace/providers";
import { Shell } from "@/features/workspace/shell";
import { publicAuthConfigured } from "@/server/env";

import "./globals.css";

import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: {
    default: "Scout · Onchain monitoring",
    template: "%s · Scout",
  },
  description:
    "Describe what matters onchain. Scout checks the data and monitoring tools it has, builds your Watch, and verifies it before activation.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#181819",
};

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const configured = publicAuthConfigured();

  return (
    <html
      lang="en"
      className={`${GeistMono.variable} ${scoutText.variable}`}
      suppressHydrationWarning
    >
      <head>
        <meta name="darkreader-lock" />
      </head>
      <body>
        <Providers authConfigured={configured}>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
