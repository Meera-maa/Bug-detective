import { TestView } from "@/components/TestView";

export const metadata = { title: "Regression Test · Bug Detective" };

export default async function TestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TestView id={id} />;
}
