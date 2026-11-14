import { ImageResponse } from "next/og";

/** The home-screen icon (iOS "Add to Home Screen"): the Forge mark, full bleed (iOS rounds the corners). */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c4dff"/><stop offset="1" stop-color="#4a1fc4"/></linearGradient><linearGradient id="sp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffc46b"/><stop offset="1" stop-color="#ff6a2b"/></linearGradient></defs><rect width="64" height="64" fill="url(#bg)"/><path d="M20.5 14h21a4.5 4.5 0 0 1 0 9H29v7h10.5a4.5 4.5 0 0 1 0 9H29v10.5a4.25 4.25 0 0 1-8.5 0V18.5a4.5 4.5 0 0 1 4.5-4.5z" fill="#fff"/><path d="M46 37.5l2.4 6.1 6.1 2.4-6.1 2.4L46 54.5l-2.4-6.1-6.1-2.4 6.1-2.4z" fill="url(#sp)"/><path d="M54 30l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" fill="#ffb15c" opacity="0.9"/></svg>`;

export default function AppleIcon() {
  return new ImageResponse(
    <img src={`data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`} width={180} height={180} alt="" />,
    size,
  );
}
