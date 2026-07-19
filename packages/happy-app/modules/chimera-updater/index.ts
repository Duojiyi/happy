import { requireNativeModule } from 'expo-modules-core';

export type InspectedApk = {
  packageName: string;
  versionName: string;
  versionCode: number;
  signerSha256: string;
};

type ChimeraUpdaterModule = {
  inspectApk(uri: string): Promise<InspectedApk>;
  canRequestPackageInstalls(): Promise<boolean>;
  openInstallPermissionSettings(): Promise<void>;
  launchInstaller(uri: string): Promise<void>;
};

export default requireNativeModule<ChimeraUpdaterModule>('ChimeraUpdater');
