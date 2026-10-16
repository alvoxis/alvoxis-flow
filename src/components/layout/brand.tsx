export function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element -- static SVG logo */}
      <img src="/icons/icon.svg" alt="" width={32} height={32} className="size-8 rounded-lg" />
      <span className="text-[15px] font-semibold tracking-tight whitespace-nowrap text-text">
        ALVOXIS <span className="text-accent">Flow</span>
      </span>
    </div>
  );
}
