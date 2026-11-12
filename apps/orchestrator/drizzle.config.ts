import { defineConfig } from "drizzle-kit";

// Local dev reads forge/.env; deployed containers get DATABASE_URL from the environment.
try {
  process.loadEnvFile?.("../../.env");
} catch {
  /* no .env file: use the process environment */
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
