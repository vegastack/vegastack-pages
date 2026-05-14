import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

type SaveStatusValue = "idle" | "saved" | "saving" | "error";

export function SaveStatus() {
  const [status, setStatus] = useState<SaveStatusValue | null>(null);

  useEffect(() => {
    function onStatus(event: Event) {
      const next = (event as CustomEvent<{ status?: SaveStatusValue }>).detail
        ?.status;
      if (next === "idle") {
        setStatus(null);
      } else if (next) {
        setStatus(next);
      }
    }
    window.addEventListener("vpg:save-status", onStatus);
    return () => window.removeEventListener("vpg:save-status", onStatus);
  }, []);

  if (!status) return null;

  const Icon =
    status === "saved"
      ? Check
      : status === "saving"
        ? LoaderCircle
        : TriangleAlert;
  const label =
    status === "saved"
      ? "Saved"
      : status === "saving"
        ? "Saving"
        : "Save failed";

  return (
    <span className="save-status" data-status={status} aria-live="polite">
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}
