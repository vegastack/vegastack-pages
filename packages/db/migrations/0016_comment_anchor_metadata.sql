ALTER TABLE comment_anchors ADD COLUMN anchor_kind TEXT NOT NULL DEFAULT 'text' CHECK (anchor_kind IN ('text', 'point'));
ALTER TABLE comment_anchors ADD COLUMN surface TEXT NOT NULL DEFAULT 'prose' CHECK (surface IN ('prose', 'html'));
ALTER TABLE comment_anchors ADD COLUMN selector_json TEXT;
ALTER TABLE comment_anchors ADD COLUMN confidence TEXT NOT NULL DEFAULT 'active' CHECK (confidence IN ('active', 'reanchored', 'fuzzy', 'manual', 'stale'));
