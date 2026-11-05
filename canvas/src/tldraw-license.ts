// tldraw production licence key, inlined at build time from VITE_TLDRAW_LICENSE_KEY (the
// compose build reads it from the tldraw_license secret). Unset: undefined, and tldraw's
// own licence check applies (HTTPS without a key counts as unlicensed production).
export const TLDRAW_LICENSE_KEY: string | undefined = import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined;
