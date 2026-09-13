import { CapabilitiesScreen } from "@/features/capabilities/catalog";

export const metadata = {
  title: "What can Scout watch?",
  robots: { index: true, follow: true },
};

export default function Page() {
  return <CapabilitiesScreen />;
}
