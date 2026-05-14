import { useEffect } from "react";
import { Toaster, toast } from "sonner";

declare global {
  interface Window {
    vpgToast: typeof toast;
  }
}

if (typeof window !== "undefined") {
  // Expose the sonner toast() function globally so Astro inline scripts can call
  // window.vpgToast.success(...) without each script having to import sonner.
  window.vpgToast = toast;
}

export function SonnerHost() {
  useEffect(() => {
    window.vpgToast = toast;
  }, []);

  return (
    <Toaster
      position="bottom-right"
      theme="system"
      closeButton
      richColors={false}
      offset={16}
      toastOptions={{
        className: "vpg-sonner-toast",
        duration: 3200,
      }}
    />
  );
}
