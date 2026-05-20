-- Workspace + user datetime preferences.
--
-- `preferences_json` is a per-row JSON blob; today it holds:
--   { "dateTime": { "dateFormat": "MMM D, YYYY", "timeFormat": "24h",
--                   "showRelativeWithinDays": 7 } }
-- Future preferences (notification cadence, search defaults, …)
-- compose into the same column so we don't add a new column per
-- preference. NOT NULL DEFAULT '{}' so existing rows are well-formed
-- after the ALTER.
ALTER TABLE workspaces ADD COLUMN preferences_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN preferences_json TEXT NOT NULL DEFAULT '{}';
