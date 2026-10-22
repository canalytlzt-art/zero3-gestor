import { clerkClient, getAuth } from "@clerk/express";
import type { Request } from "express";

const allowedEmails = new Set(
  (process.env.ZERO3_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLocaleLowerCase("en-US"))
    .filter(Boolean),
);

export async function isAuthorizedUser(req: Request): Promise<boolean> {
  const { userId } = getAuth(req);
  if (!userId || allowedEmails.size === 0) {
    return false;
  }

  const user = await clerkClient.users.getUser(userId);
  const email = user.primaryEmailAddress;
  if (!email || email.verification?.status !== "verified") {
    return false;
  }

  return allowedEmails.has(email.emailAddress.trim().toLocaleLowerCase("en-US"));
}
