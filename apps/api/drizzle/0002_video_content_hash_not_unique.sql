-- `videos (org_id, content_hash)` stops being unique.
--
-- M2 made it unique on the reasoning that a per-org content hash should
-- identify one row, so "the cache cannot accidentally fan out". M5 — the first
-- milestone that actually writes the column — found the cost of that: the
-- index makes it impossible to *record* the second import of the same file.
-- Uploading the same lecture into one org twice is an ordinary thing to do,
-- and the second video's extract job would have failed on a unique violation
-- at the moment it tried to write its own hash.
--
-- Duplicate rows sharing a hash are not a failure of the cache; they are how
-- it works. Desktop's lookup is `WHERE content_hash = ?1 AND audio_path IS NOT
-- NULL LIMIT 1` — it finds an *already-extracted sibling* and copies its work.
-- With one row per hash there is never a sibling to find.
--
-- The security property this index carries is unchanged, because it was never
-- uniqueness that provided it: the cache is per-org because every lookup runs
-- inside `withOrg()`, where RLS makes another tenant's row invisible whatever
-- the index says. Org-first ordering keeps the lookup a single range scan.

DROP INDEX IF EXISTS "uq_videos_org_content_hash";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_videos_org_content_hash" ON "videos" USING btree ("org_id","content_hash");
