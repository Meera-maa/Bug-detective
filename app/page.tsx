import { HomeWorkspace } from "@/components/HomeWorkspace";
import { LogoMark } from "@/components/SiteHeader";

export default function Home() {
  return (
    <div className="space-y-9">
      <section>
        <div>
          <div className="flex items-center gap-3">
            <LogoMark size={34} />
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Bug Detective</h1>
          </div>
          <p className="mt-3 text-lg text-muted">AI Debugging Partner</p>
          <p className="mt-1 text-2xl font-medium tracking-tight sm:text-3xl">From Error to Fix to Test.</p>
        </div>
      </section>

      <HomeWorkspace />
    </div>
  );
}
