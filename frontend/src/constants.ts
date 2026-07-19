export const COLORS = [
  '#E74C3C', // red
  '#3498DB', // blue
  '#2ECC71', // green
  '#F39C12', // orange
  '#9B59B6', // purple
] as const;

export const DEFAULT_COLOR = COLORS[0];
export const BRUSH_WIDTH = 3;

export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;

export const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws';
export const GATEWAY_HTTP_URL = import.meta.env.VITE_GATEWAY_HTTP_URL || 'http://localhost:8080';
// L6: gateway admission token. Baked into the public bundle at build time — coarse admission
// control (blocks non-browser/automated abuse), not a per-user secret. See DECISIONS.md D17.
export const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN || '';

export const RECONNECT_BASE_DELAY = 1000;
export const RECONNECT_MAX_DELAY = 30000;

export const BOARD_CODE_LENGTH = 6;
