/**
 * The dev-link map: npm package name → path of the local checkout's package
 * directory, relative to the workspace root. Lives in `.publish/dev-local.yml`.
 */
export interface DevLinkConfig {
  packages: Record<string, string>;
}

/** Where the `node_modules/<pkg>` entry currently points. */
export type InstallState =
  | 'linked' // symlink points at the local checkout
  | 'published' // resolves into the pnpm store (or anywhere that isn't the checkout)
  | 'not-installed' // no node_modules entry
  | 'not-symlink'; // a real directory — dev-link never touches these

/** Whether the local checkout could be linked right now. */
export type CheckoutState =
  | 'ready'
  | 'missing' // no package.json at the configured path
  | 'not-built'; // manifest artifacts (bin/exports/main) don't exist yet

export interface DevLinkStatusEntry {
  pkg: string;
  /**
   * Workspace-relative directory whose `node_modules` holds this entry, for a
   * package installed in a member project's own node_modules. Omitted for the
   * workspace root. One package can yield entries for several locations.
   */
  location?: string;
  /** Configured path, as written in the config (relative). */
  localPath: string;
  install: InstallState;
  checkout: CheckoutState;
  /** Version currently resolved in node_modules, when readable. */
  installedVersion?: string;
  /** Version of the local checkout, when readable. */
  localVersion?: string;
}

export interface DevLinkStatusReport {
  entries: DevLinkStatusEntry[];
  /**
   * Packages the sidecar says were linked but whose node_modules entry no
   * longer points at the checkout — i.e. a real `pnpm install` has reset the
   * overlay since the last link.
   */
  resetByInstall: string[];
}

export type DevLinkAction =
  | 'linked'
  | 'already-linked'
  | 'skipped' // not installed / checkout missing / real directory
  | 'refused' // checkout exists but isn't built
  | 'restored' // unlink: original store symlink restored byte-identically
  | 'removed' // unlink: no restorable original — a pnpm install is needed
  | 'noop'; // unlink: nothing to do

export interface DevLinkOpResult {
  pkg: string;
  /** Workspace-relative install root of this entry; omitted for the root. */
  location?: string;
  action: DevLinkAction;
  message: string;
}
