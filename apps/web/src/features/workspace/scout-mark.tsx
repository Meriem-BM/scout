import Image from "next/image";

export function ScoutMark({ className }: { className?: string }) {
  return (
    <Image
      src="/brands/scout.svg"
      alt="Scout"
      width={48}
      height={48}
      className={className}
      unoptimized
    />
  );
}
