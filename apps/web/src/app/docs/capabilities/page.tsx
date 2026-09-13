import { DocsPage } from "@/features/communication/docs";

export const metadata = {
  title: "Capabilities",
  robots: { index: true, follow: true },
};

export default function Page() {
  return <DocsPage page="capabilities" />;
}
