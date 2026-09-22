/**
 * The dev-link map: npm package name → path of the local checkout's package
 * directory, relative to the workspace root. Lives in `.publish/dev-local.yml`.
 */
export interface DevLinkConfig {
  packages: Record<string, string>;
  /** Satisfy linked packages' peer dependencies from the consumer's copies (default true). */
  peers?: boolean;
  /** Per-package peer options, keyed by package name. */
  packageOptions?: Record<string, DevLinkPackageOptions>;
}

/** Per-package options from the object form of a `packages` entry. */
export interface DevLinkPackageOptions {
  /** Override the global `peers` switch for this package. */
  peers?: boolean;
  /**
   * Extra package names to treat like declared peers — dependencies the
   * checkout declares as ordinary `dependencies` but that must be a single
   * instance shared with the consumer (rxjs, a DI runtime). The principled fix
   * is to declare them as peers in the package; this is the escape hatch.
   */
  shared?: string[];
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
  /** Only for `install: 'linked'`: one entry per declared (or shared) peer. */
  peers?: DevLinkPeerStatus[];
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
  | 'noop' // unlink: nothing to do
  | 'peer-linked' // link: a peer inside the checkout now resolves to the consumer's copy
  | 'peer-missing' // link: the consumer has no copy of a peer the checkout declares
  | 'peer-skipped' // link: the checkout's own entry for the peer is a real directory
  | 'peer-restored' // unlink: the checkout's original peer entry put back (or removed if we created it)
  | 'peer-mismatch'; // link: linked, but the consumer's version does not satisfy the declared range

export interface DevLinkOpResult {
  pkg: string;
  /** Workspace-relative install root of this entry; omitted for the root. */
  location?: string;
  action: DevLinkAction;
  message: string;
  /** For the `peer-*` actions: which peer dependency. */
  peer?: string;
}

/** Where a linked checkout resolves one of its peer dependencies. */
export type PeerState =
  | 'linked' // resolves to the consumer's copy
  | 'not-linked' // the checkout still resolves its own copy (or none)
  | 'missing' // the consumer has no copy; the checkout cannot be made to share one
  | 'optional-missing'; // as above, but the peer is declared optional

export interface DevLinkPeerStatus {
  peer: string;
  state: PeerState;
  /** The range the checkout declares, if any (`shared` entries have none). */
  range?: string;
  /** The consumer's installed version, when readable. */
  hostVersion?: string;
  /** False when hostVersion is known and does not satisfy `range`. */
  satisfies?: boolean;
}
