export const visibleSettings = [
    { id: 'terminal-connect' },
    { id: 'machines' },
    { id: 'account' },
    { id: 'appearance' },
    { id: 'agent-defaults' },
    { id: 'features' },
] as const;

export type VisibleSettingId = (typeof visibleSettings)[number]['id'];
