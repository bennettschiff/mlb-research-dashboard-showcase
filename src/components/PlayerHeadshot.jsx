import { useState } from "react";

// MLB.com-style player headshot by MLBAM person id. The d_people:generic
// transformation makes MLB's CDN serve a generic silhouette when a player
// has no current photo, so no onError fallback chain is needed — but a
// load error (offline, bad id) still hides the element entirely.
export default function PlayerHeadshot({ personId, size = 72, alt = "" }) {
  const [failed, setFailed] = useState(false);
  if (!personId || failed) return null;
  const url = `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_${size * 3},q_auto:best/v1/people/${personId}/headshot/67/current`;
  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: size, height: size, borderRadius: "50%", objectFit: "cover",
        // MLB headshots have a light studio background; a subtle ring seats
        // them on any surface.
        background: "#dfe7f2", border: "1px solid rgba(32,98,200,0.25)",
        flexShrink: 0,
      }}
    />
  );
}
