UPDATE pages
SET slug_id =
  slug || '-' ||
  substr(
    CASE
      WHEN id LIKE 'pg_%' THEN substr(id, 4)
      ELSE id
    END,
    1,
    12
  )
WHERE deleted_at IS NULL;

UPDATE search_documents
SET url = '/p/' || (
  SELECT pages.slug_id
  FROM pages
  WHERE pages.id = search_documents.page_id
)
WHERE EXISTS (
  SELECT 1
  FROM pages
  WHERE pages.id = search_documents.page_id
);
