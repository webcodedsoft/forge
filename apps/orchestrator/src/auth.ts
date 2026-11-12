import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db, schema } from "./db/index.ts";
import { env } from "./env.ts";
import { canSignUp, onUserCreated } from "./routes/team.ts";

const allowedDomains = env.ALLOWED_EMAIL_DOMAINS
  ? env.ALLOWED_EMAIL_DOMAINS.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
  : [];

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    // Private team tool: no email delivery yet, so no verification step.
    requireEmailVerification: false,
  },
  databaseHooks: {
    user: {
      create: {
        // Sign-up needs an invitation (except the very first account), and a team domain when configured.
        before: async (user) => {
          if (allowedDomains.length > 0) {
            const domain = user.email.split("@")[1]?.toLowerCase();
            if (!domain || !allowedDomains.includes(domain)) {
              throw new APIError("FORBIDDEN", { message: "Sign-up is limited to team email addresses." });
            }
          }
          if (!(await canSignUp(user.email))) {
            throw new APIError("FORBIDDEN", { message: "You need an invitation to join. Ask a workspace admin for an invite link." });
          }
        },
        // First account: workspace admin. Everyone else: the roles from their invitations.
        after: async (user) => {
          await onUserCreated(user);
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
