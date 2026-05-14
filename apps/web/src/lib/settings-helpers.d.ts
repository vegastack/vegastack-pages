type ToastTone = "success" | "error";
type ToastAction = { label: string; onClick: () => void };

type SettingsHelpers = {
  toast: (message: string, tone?: ToastTone, action?: ToastAction) => void;
  setStatus: (
    selector: string,
    state: "" | "success" | "error" | "warning" | "pending",
    message: string,
  ) => void;
  withSubmit: (form: HTMLFormElement, fn: () => Promise<void>) => Promise<void>;
  withTransition: (fn: () => void) => void;
  removeRow: (tr: HTMLTableRowElement) => void;
  fadeReload: () => void;
  closestRow: (node: Element | null) => HTMLTableRowElement | null;
  workspaceId: string;
  prefersReducedMotion: boolean;
  confirmAction?: (options: {
    title?: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "danger";
  }) => Promise<boolean>;
};

declare global {
  interface Window {
    settingsHelpers: SettingsHelpers;
  }
}

export {};
