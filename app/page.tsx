import { HomeWorkspace } from "@/components/HomeWorkspace";
import { LogoMark } from "@/components/SiteHeader";
import { Stepper } from "@/components/Stepper";

export default function Home() {
  return (
    <div className="space-y-9">
      <section className="grid items-end gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div>
          <div className="flex items-center gap-3">
            <LogoMark size={34} />
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Bug Detective</h1>
          </div>
          <p className="mt-3 text-lg text-muted">AI Debugging Partner</p>
          <p className="mt-1 text-2xl font-medium tracking-tight sm:text-3xl">From Error to Fix to Test.</p>
        </div>
        <div className="rounded-lg border border-line bg-panel px-4 py-4" aria-label="How an investigation goes">
          <Stepper done={0} />
        </div>
      </section>

      <HomeWorkspace />
    </div>
  );
}
