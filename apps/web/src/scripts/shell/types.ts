// Shell types re-exported from the server-side DocumentPayload contract.
// Keeping them in a separate file means the client-side shell controller
// has a small import surface (no Astro/Vite/Node-only imports leak in
// through the type bridge).

export type {
  DocumentPayload,
  DocumentKind,
  BreadcrumbItem,
  DocumentPermissions,
  DocumentCommentsStats,
  DocumentPublication,
  FeatureChunk,
} from "../../lib/document-payload";

export type ShellNavigateOptions = {
  // When true, history.replaceState is used instead of pushState.
  // Use for permission-driven redirects that shouldn't litter the back stack.
  replace?: boolean;
  // When true, skip the DOM swap and only update history. Used when the
  // shell receives an envelope hint that the payload hasn't changed.
  refreshOnly?: boolean;
};

export type ShellNavigateResult =
  | { ok: true; status: "swapped" | "fallback" }
  | { ok: false; status: "error"; error: Error };
