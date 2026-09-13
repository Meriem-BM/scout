import { LandingScreen } from "@/features/communication/landing";

export const metadata = {
  title: { absolute: "Scout · Intent to monitoring" },
  robots: { index: true, follow: true },
};

export default function Page() {
  return <LandingScreen />;
}
