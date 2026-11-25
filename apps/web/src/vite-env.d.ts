/// <reference types="vite/client" />

interface ConfluxDesktopApi {
  readonly isElectron: true;
  readonly platform: string;
  readonly showWindow: () => void;
  /** Native directory picker (desktop only); resolves null when canceled. */
  readonly pickDirectory?: () => Promise<string | null>;
  /** Alias for project directory picker in Conflux v2. */
  readonly pickProjectDirectory?: () => Promise<string | null>;
  /** Sync Electron nativeTheme ("dark" | "light") with the active palette. */
  readonly setNativeTheme?: (mode: string) => void;
}

interface Window {
  readonly confluxDesktop?: ConfluxDesktopApi;
}
