import {
  AppError,
  type CommentAnchorConfidence,
  type CommentAnchorInput,
  type CommentAnchorKind,
  type CommentAnchorSelector,
  type CommentAnchorSurface,
} from "@vegastack/pages-core";

const maxAnchorTextLength = 5_000;
const maxContextLength = 512;
const maxDomPathLength = 1_000;

export function coerceCommentAnchor(
  value: unknown,
  defaults: {
    contentHash: string;
    selectedText?: string;
    kind?: CommentAnchorKind;
    surface?: CommentAnchorSurface;
    confidence?: CommentAnchorConfidence;
  },
): CommentAnchorInput {
  const anchor = value && typeof value === "object" ? value : {};
  const record = anchor as Record<string, unknown>;
  const kind = coerceKind(record.anchor_kind, defaults.kind ?? "text");
  const surface =
    record.surface === "html" ? "html" : (defaults.surface ?? "prose");
  const selectedText = truncateString(
    String(
      record.selected_text ?? defaults.selectedText ?? defaultSelected(kind),
    ),
    maxAnchorTextLength,
  );
  const prefixText = truncateString(
    String(record.prefix_text ?? ""),
    maxContextLength,
  );
  const suffixText = truncateString(
    String(record.suffix_text ?? ""),
    maxContextLength,
  );
  const selector = coerceSelector(record.selector, kind);
  return {
    selectedText,
    sourceStart: finiteNumberOrNull(record.source_start),
    sourceEnd: finiteNumberOrNull(record.source_end),
    renderedDomPath: record.rendered_dom_path
      ? truncateString(String(record.rendered_dom_path), maxDomPathLength)
      : null,
    prefixText,
    suffixText,
    contentHash: String(record.content_hash ?? defaults.contentHash),
    kind,
    surface,
    selector,
    confidence: coerceConfidence(
      record.confidence,
      defaults.confidence ?? "active",
    ),
  };
}

function coerceKind(
  value: unknown,
  fallback: CommentAnchorKind,
): CommentAnchorKind {
  if (value === "rect") throw invalidAnchor("Area comments are not supported.");
  return value === "point" || value === "text" ? value : fallback;
}

function coerceConfidence(
  value: unknown,
  fallback: CommentAnchorConfidence,
): CommentAnchorConfidence {
  return value === "fuzzy" ||
    value === "manual" ||
    value === "stale" ||
    value === "reanchored" ||
    value === "active"
    ? value
    : fallback;
}

function coerceSelector(value: unknown, kind: CommentAnchorKind) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const selector: CommentAnchorSelector = {};
  if (kind === "point") {
    selector.point = coercePoint(record.point);
    selector.documentPoint = coerceDocumentPoint(record.documentPoint);
    selector.element = coerceElement(record.element);
    selector.textHit = coerceTextHit(record.textHit);
    selector.nearbyText =
      typeof record.nearbyText === "string"
        ? truncateString(record.nearbyText, maxContextLength)
        : undefined;
  }
  if (kind === "text") {
    selector.quote = coerceQuote(record.quote);
    selector.position = coercePosition(record.position);
    selector.element = coerceElement(record.element);
  }
  return selector;
}

function coercePoint(value: unknown) {
  if (!value || typeof value !== "object") {
    throw invalidAnchor("Point selector is required.");
  }
  const record = value as Record<string, unknown>;
  return {
    x: clamp01(requiredNumber(record.x, "Point x is required.")),
    y: clamp01(requiredNumber(record.y, "Point y is required.")),
    coordinateSpace: coerceCoordinateSpace(record.coordinateSpace),
    elementPath: record.elementPath
      ? truncateString(String(record.elementPath), maxDomPathLength)
      : null,
  };
}

function coerceQuote(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    exact: truncateString(String(record.exact ?? ""), maxAnchorTextLength),
    prefix: truncateString(String(record.prefix ?? ""), maxContextLength),
    suffix: truncateString(String(record.suffix ?? ""), maxContextLength),
  };
}

function coercePosition(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    sourceStart: finiteNumberOrNull(record.sourceStart),
    sourceEnd: finiteNumberOrNull(record.sourceEnd),
    renderedStart: finiteNumberOrNull(record.renderedStart),
    renderedEnd: finiteNumberOrNull(record.renderedEnd),
  };
}

function coerceElement(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    path: record.path
      ? truncateString(String(record.path), maxDomPathLength)
      : null,
    fingerprint: record.fingerprint
      ? truncateString(String(record.fingerprint), maxDomPathLength)
      : null,
    tag: record.tag ? truncateString(String(record.tag), 64) : null,
    id: record.id ? truncateString(String(record.id), 256) : null,
    className: record.className
      ? truncateString(String(record.className), 512)
      : null,
    role: record.role ? truncateString(String(record.role), 128) : null,
    ariaLabel: record.ariaLabel
      ? truncateString(String(record.ariaLabel), maxContextLength)
      : null,
    text: record.text
      ? truncateString(String(record.text), maxContextLength)
      : null,
    alt: record.alt
      ? truncateString(String(record.alt), maxContextLength)
      : null,
    title: record.title
      ? truncateString(String(record.title), maxContextLength)
      : null,
  };
}

function coerceDocumentPoint(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return {
    x: clamp01(x),
    y: clamp01(y),
    coordinateSpace: "document" as const,
  };
}

function coerceTextHit(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const exact = truncateString(String(record.exact ?? ""), maxAnchorTextLength);
  if (!exact) return undefined;
  return {
    exact,
    prefix: truncateString(String(record.prefix ?? ""), maxContextLength),
    suffix: truncateString(String(record.suffix ?? ""), maxContextLength),
    renderedStart: finiteNumberOrNull(record.renderedStart),
    renderedEnd: finiteNumberOrNull(record.renderedEnd),
  };
}

function coerceCoordinateSpace(value: unknown): "document" | "element" {
  return value === "element" ? "element" : "document";
}

function finiteNumberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requiredNumber(value: unknown, message: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw invalidAnchor(message);
  return number;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function truncateString(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function defaultSelected(kind: CommentAnchorKind) {
  return kind === "point" ? "Pinned comment" : "";
}

function invalidAnchor(message: string) {
  return new AppError("VALIDATION_ERROR", message, 400);
}
