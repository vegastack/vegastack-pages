-- Trash + Recovery feature support.
--
-- `pages.deleted_at` already records WHEN a page was soft-deleted;
-- the new `deleted_by_user_id` records WHO did it so the workspace
-- Recovery view can display "deleted by …" alongside the timestamp.
-- ON DELETE SET NULL keeps deleted-but-now-removed users from
-- breaking the trash listing.
--
-- This lives in 0003 (not 0001) so existing self-hosted D1 instances
-- can apply it as a delta. Prod was patched via a manual ALTER on
-- 2026-05-20 — anyone setting up fresh (or running migrations from
-- scratch) gets the column from this file in order.
ALTER TABLE pages ADD COLUMN deleted_by_user_id TEXT
  REFERENCES users(id) ON DELETE SET NULL;
