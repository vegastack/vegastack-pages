WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, COALESCE(parent_folder_id, '')
      ORDER BY position, name, path, id
    ) AS next_position
  FROM folders
)
UPDATE folders
SET position = (
  SELECT next_position
  FROM ranked
  WHERE ranked.id = folders.id
)
WHERE id IN (SELECT id FROM ranked);
