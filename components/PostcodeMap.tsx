"use client";

import { useEffect, useRef } from "react";
import { GeoJSON, MapContainer, TileLayer, useMapEvents } from "react-leaflet";
import type { Layer, Path } from "leaflet";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import "leaflet/dist/leaflet.css";
import { POSTCODE_AREA_NAMES } from "@/lib/postcodeDistricts";

// Map-coloring palette (adjacency-safe, NOT identity coloring — see
// scripts/build-postcode-boundaries.mjs's own header for why this is a
// different job from the dataviz skill's categorical palette). Must match
// that script's MAP_COLOR_PALETTE exactly — it's what colorSlot indexes
// into.
const MAP_COLOR_PALETTE = ["#4C8DFF", "#FF8A4C", "#4CC98A", "#E15A8A", "#B08CFF", "#F2C13B", "#3BC1D6", "#D66A3B"];

const BORDER_COLOR = "#2b2f3a";

// Below this zoom, permanent district-code labels are hidden — at a
// whole-London view, 330 simultaneous labels is just noise (and more DOM
// nodes than a low-end/mobile browser needs to paint for a view where
// individual codes aren't readable anyway). Toggled via a CSS class on the
// map container rather than opening/closing all 330 Leaflet tooltips
// imperatively on every zoom step.
const LABEL_MIN_ZOOM = 11;

export interface DistrictProperties {
  code: string;
  area: string;
  colorSlot: number;
}

export interface SelectedDistrict {
  code: string;
  areaName: string;
  count: number;
}

interface Props {
  districts: FeatureCollection<Geometry, DistrictProperties>;
  counts: Record<string, number>;
  onSelect: (district: SelectedDistrict) => void;
}

/** Toggles a class on the map container based on zoom level — the
 * mechanism behind LABEL_MIN_ZOOM (see its own comment). A child of
 * <MapContainer> so it can reach the Leaflet map instance via the
 * react-leaflet hooks. */
function ZoomLabelToggle() {
  const map = useMapEvents({
    zoomend: () => {
      const container = map.getContainer();
      container.classList.toggle("postcode-map--labels-visible", map.getZoom() >= LABEL_MIN_ZOOM);
    },
  });

  useEffect(() => {
    map.getContainer().classList.toggle("postcode-map--labels-visible", map.getZoom() >= LABEL_MIN_ZOOM);
  }, [map]);

  return null;
}

export default function PostcodeMap({ districts, counts, onSelect }: Props) {
  // Tracks whichever district layer is currently "selected" (last
  // clicked) so its highlight can be cleared when a different one is
  // clicked, without re-styling all 330 layers on every click.
  const selectedLayerRef = useRef<Path | null>(null);

  function styleFeature(feature?: Feature<Geometry, DistrictProperties>) {
    const color = MAP_COLOR_PALETTE[feature?.properties.colorSlot ?? 0] ?? MAP_COLOR_PALETTE[0];
    return {
      fillColor: color,
      fillOpacity: 0.55,
      color: BORDER_COLOR,
      weight: 1,
    };
  }

  function onEachFeature(feature: Feature<Geometry, DistrictProperties>, layer: Layer) {
    const { code, area } = feature.properties;
    const count = counts[code] ?? 0;

    layer.bindTooltip(code, {
      permanent: true,
      direction: "center",
      className: "postcode-map__label",
    });

    const path = layer as Path;
    path.on("mouseover", () => {
      if (path !== selectedLayerRef.current) path.setStyle({ weight: 2.5, fillOpacity: 0.75 });
    });
    path.on("mouseout", () => {
      if (path !== selectedLayerRef.current) path.setStyle({ weight: 1, fillOpacity: 0.55 });
    });
    path.on("click", () => {
      if (selectedLayerRef.current && selectedLayerRef.current !== path) {
        selectedLayerRef.current.setStyle({ weight: 1, fillOpacity: 0.55 });
      }
      path.setStyle({ weight: 3, fillOpacity: 0.85 });
      path.bringToFront();
      selectedLayerRef.current = path;

      onSelect({
        code,
        areaName: POSTCODE_AREA_NAMES[area] ?? area,
        count,
      });
    });
  }

  return (
    <MapContainer
      center={[51.509, -0.118]}
      zoom={10}
      minZoom={9}
      maxZoom={16}
      scrollWheelZoom
      className="postcode-map"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ZoomLabelToggle />
      <GeoJSON data={districts} style={styleFeature} onEachFeature={onEachFeature} />
    </MapContainer>
  );
}
