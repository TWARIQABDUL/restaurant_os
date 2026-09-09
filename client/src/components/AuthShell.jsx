import { UtensilsCrossed, Check } from 'lucide-react';

const POINTS = [
  'Real-time order board',
  'Your own branded ordering page',
  'No marketplace commission',
];

/**
 * Split-screen shell for the auth pages: dark brand panel on the left
 * (hidden on mobile), form slot on the right.
 */
export default function AuthShell({ heading, subheading, children }) {
  return (
    <div className="grid min-h-[calc(100vh-3.75rem)] lg:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-[#0f172a] p-11 text-white lg:flex">
        <div className="pointer-events-none absolute -right-32 -top-32 h-[360px] w-[360px] rounded-full bg-[#dc2626] opacity-[0.14]" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-[#dc2626]">
            <UtensilsCrossed size={19} />
          </div>
          <span className="font-heading text-[17px] font-semibold">Restaurant OS</span>
        </div>

        <div className="relative">
          <h1 className="font-heading text-[28px] font-bold leading-tight">{heading}</h1>
          <p className="mt-3.5 max-w-[340px] text-sm leading-relaxed text-[#94a3b8]">{subheading}</p>
          <div className="mt-6 flex flex-col gap-3">
            {POINTS.map(point => (
              <div key={point} className="flex items-center gap-2.5 text-[13px] text-[#e2e8f0]">
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#dc2626]/20 text-[#f87171]">
                  <Check size={11} strokeWidth={3} />
                </span>
                {point}
              </div>
            ))}
          </div>
        </div>

        <div className="relative text-xs text-[#64748b]">© 2026 Restaurant OS</div>
      </div>

      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-[360px]">{children}</div>
      </div>
    </div>
  );
}
