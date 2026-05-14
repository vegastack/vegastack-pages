import { Search } from "lucide-react";
import { useEffect, useState } from "react";

type NavigatorWithUAData = Navigator & {
  userAgentData?: { platform?: string };
};

type SidebarSearchProps = {
  initialIsMac?: boolean;
};

/**
 * Full-width search trigger that lives under the workspace pill in the
 * sidebar head. The client detects the platform after hydration so prerendered
 * pages never need request-header access just for a shortcut hint.
 */
export function SidebarSearch({ initialIsMac = false }: SidebarSearchProps) {
  const [isMac, setIsMac] = useState(initialIsMac);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const nav = navigator as NavigatorWithUAData;
    const platform = (
      nav.userAgentData?.platform ?? navigator.userAgent
    ).toLowerCase();
    setIsMac(/mac|iphone|ipad|ipod/.test(platform));
  }, []);

  function openSearch() {
    window.dispatchEvent(new CustomEvent("vpg:open-search"));
  }

  return (
    <button
      type="button"
      className="vpg-sidebar-search"
      onClick={openSearch}
      aria-label="Search workspace"
    >
      <Search className="vpg-sidebar-search-icon" aria-hidden="true" />
      <span className="vpg-sidebar-search-label">Search</span>
      <kbd className="vpg-sidebar-search-kbd" aria-hidden="true">
        {isMac ? (
          <>
            <span>⌘</span>
            <span>K</span>
          </>
        ) : (
          <>
            <span>Ctrl</span>
            <span>K</span>
          </>
        )}
      </kbd>
    </button>
  );
}
