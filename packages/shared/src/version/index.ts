// Merqo's release recipe also supplies the Windows installer's version.
// Do not expose the inherited Craft Agents package version to Merqo users.
import release from '../../../../packaging/windows-release.json';

export const APP_VERSION: string = release.version;

export function getAppVersion(): string {
  return APP_VERSION;
}

export * from './install.ts';
export * from './manifest.ts';
export * from './version.ts';
