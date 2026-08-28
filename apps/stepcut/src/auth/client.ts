// The `better-auth` browser client.
//
// Web-only — there is no desktop counterpart to any of this. It talks to the
// same `/api/auth/*` routes `apps/stepcut-api` mounts, on the same origin
// (Vite proxies in dev, Caddy in production), so the session cookie is a
// first-party httpOnly cookie the browser attaches on its own. Nothing here
// reads, stores or forwards a token.
//
// Copied from apps/web/src/auth/client.ts. Only the exports `AuthScreen`,
// `CreateOrgScreen`, `SessionGate` and `AppShell` actually call are kept —
// `updateUser`/`changePassword`/`requestPasswordReset`/`resetPassword`/
// `deleteUser` are apps/web's, used by `AccountDialog`, which apps/stepcut
// doesn't have in Phase 1 (see `AppShell.tsx`'s header).
//
// The server pins tenancy to `sessions.active_organization_id`, so the
// organization plugin's `setActive` is the *only* writer of the value RLS
// keys on. That is deliberate (see `apps/stepcut-api/src/routes/orgs.ts`):
// this file switches orgs by calling it, never by telling our own API which
// tenant to use.

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // Same origin, same base path as `apps/stepcut-api/src/auth.ts`'s `basePath`.
  basePath: "/api/auth",
  plugins: [organizationClient()],
});

export const { useSession, signIn, signUp, signOut, organization } = authClient;

/** What a `better-auth` call reports when it fails. The client resolves with
 * `{ data, error }` rather than rejecting, so every caller here funnels
 * through this to get a string a `<Alert>` can render. */
export function authErrorMessage(error: { message?: string; statusText?: string } | null): string {
  return error?.message ?? error?.statusText ?? "Something went wrong. Please try again.";
}

/**
 * An organization slug derived from its name.
 *
 * `better-auth` requires one and enforces uniqueness, but a slug is not a
 * thing a user signing up should have to think about. So it is derived, and
 * a collision is resolved by suffixing rather than by asking (see
 * `createOrganization` below).
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

/** A short random suffix for a slug that is already taken. */
function slugSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Creates an organization and makes it the session's active one.
 *
 * Slug uniqueness is global, so a second "Acme University" would otherwise
 * fail on a value the user never chose and cannot see. One suffixed retry
 * turns that into a non-event; a second collision is worth reporting.
 *
 * `create` already marks the new org active, but it is set explicitly anyway:
 * that column is what the server's RLS scoping keys on, so it is not a value
 * to leave to a library default.
 */
export async function createOrganization(name: string): Promise<string> {
  const trimmed = name.trim();
  const slug = slugify(trimmed);
  const first = await organization.create({ name: trimmed, slug });
  const created = first.error
    ? await organization.create({ name: trimmed, slug: `${slug}-${slugSuffix()}` })
    : first;
  if (created.error || !created.data) throw new Error(authErrorMessage(created.error));
  await organization.setActive({ organizationId: created.data.id });
  return created.data.id;
}
