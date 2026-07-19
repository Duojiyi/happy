import * as React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { visibleSettings } from '@/chimera/visibleSettings';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { t } from '@/text';

export const SettingsView = React.memo(function SettingsView() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();
    const allMachinesWithOffline = useAllMachines({ includeOffline: true });
    const [showOfflineMachines, setShowOfflineMachines] = React.useState(false);
    const visibleMachines = showOfflineMachines
        ? allMachinesWithOffline
        : allMachinesWithOffline.filter(isMachineOnline);
    const offlineMachineCount = allMachinesWithOffline.filter((machine) => !isMachineOnline(machine)).length;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {visibleSettings.map((setting) => {
                switch (setting.id) {
                    case 'terminal-connect':
                        return Platform.OS === 'web' ? null : (
                            <ItemGroup key={setting.id}>
                                <Item
                                    title={t('settings.scanQrCodeToAuthenticate')}
                                    icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                                    onPress={connectTerminal}
                                    loading={isLoading}
                                    showChevron={false}
                                />
                                <Item
                                    title={t('connect.enterUrlManually')}
                                    icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                                    onPress={async () => {
                                        const url = await Modal.prompt(t('modals.authenticateTerminal'), t('modals.pasteUrlFromTerminal'), {
                                            placeholder: 'happy://terminal?...',
                                            confirmText: t('common.authenticate'),
                                        });
                                        if (url?.trim()) connectWithUrl(url.trim());
                                    }}
                                    showChevron={false}
                                />
                            </ItemGroup>
                        );
                    case 'machines':
                        return allMachinesWithOffline.length === 0 ? null : (
                            <ItemGroup key={setting.id} title={t('settings.machines')}>
                                {visibleMachines.map((machine) => {
                                    const isOnline = isMachineOnline(machine);
                                    const host = machine.metadata?.host || 'Unknown';
                                    const title = machine.metadata?.displayName || host;
                                    const platform = machine.metadata?.platform;
                                    const subtitle = [machine.metadata?.displayName !== host ? host : undefined, platform, isOnline ? t('status.online') : t('status.offline')]
                                        .filter(Boolean).join(' • ');
                                    return <Item key={machine.id} title={title} subtitle={subtitle} icon={<Ionicons name="desktop-outline" size={29} color={isOnline ? theme.colors.status.connected : theme.colors.status.disconnected} />} onPress={() => router.push(`/machine/${machine.id}`)} />;
                                })}
                                {offlineMachineCount > 0 && <Item title={showOfflineMachines ? t('settings.hideOfflineMachines') : t('settings.showOfflineMachines', { count: offlineMachineCount })} onPress={() => setShowOfflineMachines((value) => !value)} showChevron={false} titleStyle={{ textAlign: 'center', color: theme.colors.textLink }} />}
                            </ItemGroup>
                        );
                    case 'account':
                        return <ItemGroup key={setting.id}><Item title={t('settings.account')} subtitle={t('settings.accountSubtitle')} icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />} onPress={() => router.push('/settings/account')} /></ItemGroup>;
                    case 'appearance':
                        return <ItemGroup key={setting.id}><Item title={t('settings.appearance')} subtitle={t('settings.appearanceSubtitle')} icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />} onPress={() => router.push('/settings/appearance')} /></ItemGroup>;
                    case 'agent-defaults':
                        return <ItemGroup key={setting.id}><Item title="Agent Defaults" subtitle="Default model, effort, and permissions" icon={<Ionicons name="options-outline" size={29} color="#5AC8FA" />} onPress={() => router.push('/settings/agents' as never)} /></ItemGroup>;
                    case 'features':
                        return <ItemGroup key={setting.id}><Item title={t('settings.featuresTitle')} subtitle={t('settings.featuresSubtitle')} icon={<Ionicons name="flask-outline" size={29} color="#FF9500" />} onPress={() => router.push('/settings/features')} /></ItemGroup>;
                }
            })}
        </ItemList>
    );
});
