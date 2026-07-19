export const SERVER_DISABLED_DEFAULT_CONFIG = {
    announcement: {
        enabled: false,
        title: '',
        body: '',
        primaryButtonLabel: '',
        linkButtonLabel: null,
        linkUrl: null,
    },
    androidUpdateManifestPath: '/downloads/chimera-update.json',
} as const;

export const SERVER_ENABLED_CONFIG = {
    announcement: {
        enabled: true,
        title: 'Maintenance',
        body: 'A brief announcement',
        primaryButtonLabel: 'Continue',
        linkButtonLabel: 'Learn more',
        linkUrl: 'https://example.test/info',
    },
    androidUpdateManifestPath: '/downloads/chimera-update.json',
} as const;
