import { useEffect, useState } from "react";
import { CommandPaletteDialog } from "./CommandPaletteDialog";

type CommandPaletteProps = {
  workspaceId: string;
};

export function CommandPalette({ workspaceId }: CommandPaletteProps) {
  const [openIntent, setOpenIntent] = useState(0);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpenIntent((value) => value + 1);
      }
    }
    function onOpenSearch() {
      setOpenIntent((value) => value + 1);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("vpg:open-search", onOpenSearch);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("vpg:open-search", onOpenSearch);
    };
  }, []);

  return (
    <CommandPaletteDialog workspaceId={workspaceId} openIntent={openIntent} />
  );
}
