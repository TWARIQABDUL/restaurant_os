import { Store } from 'lucide-react';
import { BRAND } from '../config/brand';

/**
 * Brand mark + wordmark. `size` scales the mark; omit `showName` for the mark alone.
 */
export default function Logo({ size = 32, showName = true, className = '', nameClassName = '' }) {
  const icon = Math.round(size * 0.56);
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span
        className="flex shrink-0 items-center justify-center rounded-lg bg-[#dc2626] text-white"
        style={{ width: size, height: size }}
      >
        <Store size={icon} strokeWidth={1.9} />
      </span>
      {showName && (
        <span className={`font-heading font-semibold tracking-tight ${nameClassName || 'text-[17px]'}`}>
          {BRAND.name}
        </span>
      )}
    </span>
  );
}
