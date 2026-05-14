import { Check, PencilLine } from "lucide-react";
import { useEffect, useState } from "react";

type Props = {
  className?: string;
};

export function PageEditToggle({ className = "" }: Props) {
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    function onEditState(event: Event) {
      const editable = Boolean(
        (event as CustomEvent<{ editable?: boolean }>).detail?.editable,
      );
      setEditing(editable);
    }
    window.addEventListener("vpg:edit-state", onEditState);
    return () => window.removeEventListener("vpg:edit-state", onEditState);
  }, []);

  const Icon = editing ? Check : PencilLine;
  const label = editing ? "Done" : "Edit";

  function toggleEdit() {
    window.__vpgEditIntent = true;
    window.dispatchEvent(new CustomEvent("vpg:toggle-edit", { detail: {} }));
  }

  return (
    <button
      type="button"
      className={`vpg-pheader-btn vpg-pheader-edit${editing ? " is-editing" : ""}${className ? ` ${className}` : ""}`}
      data-vpg-toggle-edit
      data-edit-label-ready="Edit"
      data-edit-label-editing="Done"
      aria-pressed={editing}
      aria-label={editing ? "Done editing" : "Edit page"}
      title={editing ? "Done editing" : "Edit page"}
      onClick={toggleEdit}
    >
      <Icon aria-hidden="true" />
      <span className="sr-only" data-edit-label>
        {label}
      </span>
    </button>
  );
}

declare global {
  interface Window {
    __vpgEditIntent?: boolean;
  }
}
