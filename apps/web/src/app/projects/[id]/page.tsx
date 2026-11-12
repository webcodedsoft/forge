import { Suspense } from "react";
import { ForgeLoader } from "@/components/loading";
import { ProjectView } from "./project-view";

export default function ProjectPage() {
  return (
    <Suspense
      fallback={
        <main className="grid h-dvh place-items-center bg-paper">
          <ForgeLoader label="Opening the project…" />
        </main>
      }
    >
      <ProjectView />
    </Suspense>
  );
}
