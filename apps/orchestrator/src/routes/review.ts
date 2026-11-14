import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../index.ts";
import { a11yFixPrompt, getReview, latestReview, listReviews, reviewImage, reviewVersion } from "../review.ts";
import { activeRunId, RunConflictError, startRun } from "../runs.ts";

/*
 * Version reviews: which pages look different per version, the pictures, and the accessibility
 * findings. Reading needs viewer; checking again and fixing need builder (access.ts).
 */
export const reviewRoutes = new Hono<AppEnv>()
  .get("/:id/reviews", async (c) => c.json(await listReviews(c.req.param("id"))))
  .get("/:id/reviews/latest", async (c) => c.json(await latestReview(c.req.param("id"))))
  .get("/:id/reviews/:sha", async (c) => {
    const review = await getReview(c.req.param("id"), c.req.param("sha"));
    return review ? c.json(review) : c.json({ error: "This version has no review." }, 404);
  })
  .get("/:id/reviews/:sha/image/:name", async (c) => {
    const { id, sha, name } = c.req.param();
    const png = await reviewImage(id, sha, name);
    if (!png) return c.json({ error: "not_found" }, 404);
    // A version's pictures never change.
    return c.body(new Uint8Array(png), 200, { "content-type": "image/png", "cache-control": "private, max-age=86400, immutable" });
  })
  // Load every page again and review the current version (screenshots + accessibility).
  .post("/:id/reviews/check", async (c) => {
    if (activeRunId(c.req.param("id"))) return c.json({ error: "The agent is working. Try again when it has finished." }, 409);
    const review = await reviewVersion(c.req.param("id"));
    return review ? c.json(review) : c.json({ error: "The pages could not be checked. Make sure the app is running, then try again." }, 502);
  })
  .post("/:id/a11y/fix", async (c) => {
    const body = z.object({ ids: z.union([z.array(z.string().max(10)).min(1).max(50), z.literal("all")]) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Say which problems to fix." }, 400);
    const review = await latestReview(c.req.param("id"));
    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    const picked = (review?.a11y ?? [])
      .filter((f) => body.data.ids === "all" || body.data.ids.includes(f.id))
      .sort((a, b) => order[a.impact] - order[b.impact])
      .slice(0, 12);
    if (!picked.length) return c.json({ error: "Those problems are no longer in the latest check. Check again." }, 400);
    try {
      const user = c.get("user");
      return c.json({ runId: await startRun(c.req.param("id"), a11yFixPrompt(picked), { id: user.id, name: user.name }) });
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: "The agent is busy. Try again when it has finished." }, 409);
      throw err;
    }
  });
