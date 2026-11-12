import { RouteBar, Skeleton, SkeletonRows } from "@/components/loading";

/** Shown while a page in the app shell loads: the top bar plus the page's rough shape. */
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <RouteBar />
      <Skeleton className="h-7 w-56" />
      <Skeleton className="skel-line mt-3 w-96 max-w-full opacity-70" />
      <div className="card mt-6 overflow-hidden">
        <SkeletonRows n={5} />
      </div>
    </main>
  );
}
