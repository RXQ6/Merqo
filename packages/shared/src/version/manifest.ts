/** RetailPilot has no configured update service. No upstream requests. */
export async function getLatestVersion(): Promise<string | null> { return null; }
export async function getManifest(_version: string): Promise<VersionManifest | null> { return null; }

export interface BinaryInfo {
  url: string;
  sha256: string;
  size: number;
  filename?: string;
}

export interface VersionManifest {
  version: string;
  build_time: string;
  build_timestamp: number;
  binaries: Record<string, BinaryInfo>;
}
