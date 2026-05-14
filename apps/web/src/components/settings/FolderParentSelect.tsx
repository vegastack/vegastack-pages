import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type FolderParentOption = { value: string; label: string };

type FolderParentSelectProps = {
  workspaceId: string;
  folderId: string;
  folderPath: string;
  initialParentId: string | null;
  options: FolderParentOption[];
};

// Radix Select disallows empty string values, so we use a sentinel for "root".
const ROOT_VALUE = "__root__";

export function FolderParentSelect({
  workspaceId,
  folderId,
  folderPath,
  initialParentId,
  options,
}: FolderParentSelectProps) {
  const normalizedOptions = useMemo(
    () =>
      options.map((option) =>
        option.value === "" ? { ...option, value: ROOT_VALUE } : option,
      ),
    [options],
  );
  const [value, setValue] = useState<string>(initialParentId ?? ROOT_VALUE);
  const [pending, setPending] = useState(false);

  const selectedLabel =
    normalizedOptions.find((option) => option.value === value)?.label ?? "Root";

  const onValueChange = async (next: string) => {
    const previous = value;
    setValue(next);
    setPending(true);
    const parent_folder_id = next === ROOT_VALUE ? null : next;
    try {
      const response = await fetch(
        `/api/folders/${folderId}?workspace_id=${encodeURIComponent(workspaceId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parent_folder_id }),
        },
      );
      if (response.ok) {
        toast("Folder saved.");
      } else {
        const payload = await response.json().catch(() => null);
        setValue(previous);
        toast.error(payload?.error?.message ?? "Folder save failed.");
      }
    } catch {
      setValue(previous);
      toast.error("Folder save failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Select value={value} onValueChange={onValueChange} disabled={pending}>
      <SelectTrigger
        className="settings-inline-select"
        aria-label={`Parent for ${folderPath}`}
      >
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {normalizedOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
