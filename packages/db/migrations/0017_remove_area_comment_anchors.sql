UPDATE comment_anchors
SET
  anchor_kind = 'point',
  selected_text = CASE
    WHEN selected_text = '' OR selected_text = 'Selected area' THEN 'Pinned comment'
    ELSE selected_text
  END
WHERE anchor_kind = 'rect';
