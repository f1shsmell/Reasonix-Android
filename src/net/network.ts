/**
 * The phone's default network, told apart from whether it has internet.
 *
 * A LAN-first client must not read Android's "validated internet" as "there
 * is no network": a Wi-Fi with only the kernel on it is connected, just not
 * validated. The link machine gates attempts on `connected` (a default network
 * exists); the UI may still explain that internet is not available.
 */
export type NetworkKind = "wifi" | "cellular" | "ethernet" | "vpn" | "other" | "none";

export interface NetworkStatus {
  /** A default network exists; it may not have passed internet validation. */
  connected: boolean;
  connectionType: NetworkKind;
  /** Android's validated internet capability. */
  validated: boolean;
  /** Stable id of the default network; "" when there is none. */
  networkKey: string;
}
