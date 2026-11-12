import { Suspense } from "react";
import { ForgeLoader } from "@/components/loading";
import { InviteView } from "./invite-view";

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-dvh place-items-center bg-paper">
          <ForgeLoader label="Opening your invitation…" />
        </main>
      }
    >
      <InviteView />
    </Suspense>
  );
}
