import { DocsPage } from "@/features/communication/docs";

export const metadata = {
  title: "Scout in 60 seconds",
  robots: { index: true, follow: true },
};

export default function Page() {
  return <DocsPage page="overview" />;
}
