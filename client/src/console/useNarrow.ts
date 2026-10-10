// client/src/console/useNarrow.ts — milestone 28. Whether the viewport is below the console's `lg` breakpoint (1024px).
//
// FOR THE ONE DECISION CSS CANNOT MAKE: which COMPONENT to mount. A layout that merely re-flows is Tailwind's job (`lg:`), and most of
// the console does exactly that; Store design is different in kind — a phone gets a different screen (MobileLook), not a squeezed one,
// and mounting both and hiding one with CSS would run two copies of the same autosaving draft. False on the server and on first paint
// where there is no window, so a render without a viewport draws the desktop version.

import { useEffect, useState } from 'react';

const QUERY = '(max-width: 1023px)';

export function useNarrow(initial?: boolean): boolean {
  const [narrow, setNarrow] = useState(initial ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const q = window.matchMedia(QUERY);
    const on = (): void => setNarrow(q.matches);
    on();
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return narrow;
}
