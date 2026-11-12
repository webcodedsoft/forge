import { ForgeLoader, RouteBar } from "@/components/loading";

/** Opening a project: the animated Forge mark until the builder is ready. */
export default function Loading() {
  return (
    <main className="grid h-dvh place-items-center bg-paper">
      <RouteBar />
      <ForgeLoader label="Opening the project…" />
    </main>
  );
}
