import { requireNativeModule } from 'expo-modules-core';

export type ApkInspection = {
  packageName: string;
  versionName: string | null;
  versionCode: string;
  signerSha256: string[];
};

type ChimeraUpdaterModule = {
  inspectApk(uri: string): Promise<ApkInspection>;
  canRequestPackageInstalls(): boolean;
  openInstallPermissionSettings(): void;
  launchInstaller(uri: string): void;
};

export default requireNativeModule<ChimeraUpdaterModule>('ChimeraUpdater');
