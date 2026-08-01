// The org switcher's data (plan §4.1), read from `GET /api/orgs`.
//
// Read from our own API rather than from `better-auth`'s `organization.list()`
// on purpose: `apps/api` is the authority on *which* org a request is actually
// executing as. Its `requireOrg` re-checks membership and, for a session whose
// active org was cleared, adopts one and writes it back — so the session
// column the client can see is not always what the server used. Asking the
// server keeps the switcher's "active" marker and the tenant the copied views
// are reading from as the same fact.

import { useCallback, useEffect, useState } from "react";
import { ApiError, request } from "../api";

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  /** "owner" | "admin" | "member" — the caller's role in that org. */
  role: string;
}

interface OrgsResponse {
  active_org_id: string;
  orgs: OrgSummary[];
}

export interface OrgsState {
  orgs: OrgSummary[];
  activeOrgId: string | null;
  /** The caller's role in the active org, or `null` while loading. */
  role: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useOrgs(enabled: boolean): OrgsState {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await request<OrgsResponse>("GET", "/orgs");
      setOrgs(data.orgs);
      setActiveOrgId(data.active_org_id);
      setError(null);
    } catch (err) {
      // 403 is `requireOrg` reporting an account with no memberships at all —
      // a real state (an invitation that was never accepted), and one the gate
      // renders as "create or join an org" rather than as an error.
      if (err instanceof ApiError && err.status === 403) {
        setOrgs([]);
        setActiveOrgId(null);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = orgs.find((org) => org.id === activeOrgId);
  return { orgs, activeOrgId, role: active?.role ?? null, loading, error, refresh };
}
