// Settings — analysis instructions, and nothing else.
//
// Desktop's `app_settings` row held two things: the free-text analysis
// preferences appended to the GPT-5.5 prompt, and the user's OpenAI key. Only
// the first survives here (D7).
//
// There is no `/settings/openai-key` route, and there is no key column in
// `org_settings` to serve one from. The web app is not BYOK: one
// platform-owned key lives in the API's environment, is used for every
// tenant, and never reaches the browser or the database. `db.ts` correspondingly
// drops `saveOpenAiKey`/`getOpenAiKeyStatus`/`testOpenAiKey` — removed rather
// than stubbed, so the compile error lands in the view that has to change
// rather than shipping a form that silently does nothing.
//
// The instructions themselves stay per-org and stay editable. The key is
// ours; what the model is asked to do is still the tenant's.

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { tx, type AppEnv } from "../http/context.js";
import { orgSettings } from "../db/schema.js";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/settings/analysis-instructions", async (c) => {
  const [row] = await tx(c, (t) =>
    t
      .select({ instructions: orgSettings.analysisInstructions })
      .from(orgSettings)
      .where(eq(orgSettings.orgId, c.get("orgId")))
      .limit(1),
  );
  // No row yet is the same answer as a row with no instructions — an org that
  // has never opened Settings should not read differently from one that
  // cleared the box.
  return c.json({ instructions: row?.instructions ?? null });
});

settingsRoutes.put("/settings/analysis-instructions", async (c) => {
  const body = await c.req.json<{ instructions?: string }>();
  const orgId = c.get("orgId");
  const instructions = body.instructions ?? "";

  await tx(c, (t) =>
    t
      .insert(orgSettings)
      .values({ orgId, analysisInstructions: instructions, updatedAt: new Date() })
      // Upsert, because `org_settings` is created with the org but a tenant
      // that predates this table (or a hand-created org) would otherwise get
      // a silent no-op.
      .onConflictDoUpdate({
        target: orgSettings.orgId,
        set: { analysisInstructions: instructions, updatedAt: new Date() },
      }),
  );
  return c.body(null, 204);
});
