import type { SelectedDistrict } from "./PostcodeMap";

interface Props {
  selected: SelectedDistrict | null;
  totalDistricts: number;
  totalCounted: number;
}

/**
 * A React-state-driven info panel rather than relying only on Leaflet's
 * own popups — several London districts (EC1A, W1B, ...) are small enough
 * that a tiny popup anchored right at the tap point is fiddly on mobile;
 * this stays fixed, legible, and always in the same place regardless of
 * which (or how small a) district was tapped.
 */
export default function PostcodeDistrictPanel({ selected, totalDistricts, totalCounted }: Props) {
  if (!selected) {
    return (
      <section className="stats-card postcode-panel">
        <h2 className="stats-card__heading">District details</h2>
        <p className="postcode-panel__hint">
          Click any district on the map to see its listing count. {totalDistricts} districts shown,{" "}
          {totalCounted} of your active listings have a postcode that matches one of them.
        </p>
      </section>
    );
  }

  return (
    <section className="stats-card postcode-panel">
      <h2 className="stats-card__heading">District details</h2>
      <div className="postcode-panel__code">{selected.code}</div>
      <div className="postcode-panel__area">{selected.areaName}</div>
      <div className="postcode-panel__count">
        <strong>{selected.count}</strong> listing{selected.count === 1 ? "" : "s"}
      </div>
    </section>
  );
}
