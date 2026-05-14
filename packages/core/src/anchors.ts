export type CommentAnchor = {
  selectedText: string;
  sourceStart: number | null;
  sourceEnd: number | null;
  prefixText: string;
  suffixText: string;
  renderedDomPath?: string | null;
  contentHash: string;
};

export type ReanchorResult =
  | { status: "active"; start: number; end: number }
  | { status: "reanchored"; start: number; end: number }
  | { status: "stale"; start: null; end: null };

export function reanchorText(
  source: string,
  anchor: CommentAnchor,
): ReanchorResult {
  if (
    anchor.sourceStart !== null &&
    anchor.sourceEnd !== null &&
    source.slice(anchor.sourceStart, anchor.sourceEnd) === anchor.selectedText
  ) {
    return {
      status: "active",
      start: anchor.sourceStart,
      end: anchor.sourceEnd,
    };
  }

  const nearOffset = anchor.sourceStart ?? 0;
  const windowStart = Math.max(0, nearOffset - 500);
  const windowEnd = Math.min(
    source.length,
    nearOffset + anchor.selectedText.length + 500,
  );
  const nearby = source.slice(windowStart, windowEnd);
  const nearbyIndex = nearby.indexOf(anchor.selectedText);
  if (nearbyIndex >= 0) {
    const start = windowStart + nearbyIndex;
    return {
      status: "reanchored",
      start,
      end: start + anchor.selectedText.length,
    };
  }

  const contextualNeedle = `${anchor.prefixText}${anchor.selectedText}${anchor.suffixText}`;
  if (contextualNeedle.length > anchor.selectedText.length) {
    const contextIndex = source.indexOf(contextualNeedle);
    if (contextIndex >= 0) {
      const start = contextIndex + anchor.prefixText.length;
      return {
        status: "reanchored",
        start,
        end: start + anchor.selectedText.length,
      };
    }
  }

  const globalIndex = source.indexOf(anchor.selectedText);
  if (globalIndex >= 0) {
    return {
      status: "reanchored",
      start: globalIndex,
      end: globalIndex + anchor.selectedText.length,
    };
  }

  return { status: "stale", start: null, end: null };
}
