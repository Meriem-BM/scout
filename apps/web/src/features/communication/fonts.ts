import localFont from "next/font/local";

export const scoutText = localFont({
  src: [
    { path: "./fonts/manrope-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/manrope-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/manrope-600.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  variable: "--font-scout",
});
