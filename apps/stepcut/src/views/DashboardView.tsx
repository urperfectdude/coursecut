// The signed-in empty dashboard (docs/stepcut-plan.md §8, Phase 1 "Scaffold")
// — this is literally the whole product surface Phase 1 ships. No coursecut
// counterpart: apps/stepcut's views are original, not ported from desktop.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { OrgSummary } from "@/auth/useOrgs";

interface DashboardViewProps {
  org: OrgSummary | undefined;
}

export default function DashboardView({ org }: DashboardViewProps) {
  return (
    <div className="mx-auto max-w-2xl p-8">
      <Card>
        <CardHeader>
          <CardTitle>{org?.name ?? "Your organization"}</CardTitle>
          <CardDescription>
            Nothing here yet — StepCut's upload and step-editing tools are coming soon.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Once uploads are live, this is where you'll turn a narrated screen recording into a
            step-by-step tutorial.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
