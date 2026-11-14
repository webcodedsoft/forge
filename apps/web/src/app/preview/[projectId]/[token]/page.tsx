import { Suspense } from "react";
import { ForgeLoader } from "@/components/loading";
import { SharedPreview } from "./shared-preview";

/** A shared preview: /preview/<projectId>/<token>. Public; the token in the link is the access. */
export default function SharedPreviewPage() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-dvh place-items-center bg-paper">
          <ForgeLoader label="Opening the preview…" />
        </main>
      }
    >
      <SharedPreview />
    </Suspense>
  );
}
