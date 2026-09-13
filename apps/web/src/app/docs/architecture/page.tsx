import { DocsPage } from "@/features/communication/docs";

export const metadata = {
  title: "Scout architecture",
  robots: { index: true, follow: true },
};

export default function Page() {
  return <DocsPage page="architecture" />;
}
