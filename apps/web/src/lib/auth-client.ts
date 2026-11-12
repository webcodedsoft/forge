"use client";

import { createAuthClient } from "better-auth/react";

// Same origin: /api/auth/* is rewritten to the orchestrator.
export const authClient = createAuthClient();
export const { signIn, signUp, signOut, useSession } = authClient;
