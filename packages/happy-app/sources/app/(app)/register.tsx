import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getRandomBytesAsync } from 'expo-crypto';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { authGetToken } from '@/auth/authGetToken';
import { encodeBase64 } from '@/encryption/base64';
import { RoundButton } from '@/components/RoundButton';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { trackAccountCreated } from '@/track';
import { canRegister } from '@/auth/registerAccess';

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, alignItems: 'center', padding: 24, backgroundColor: theme.colors.surface },
    content: { width: '100%', maxWidth: 480, paddingTop: 24 },
    instruction: { fontSize: 16, marginBottom: 16, color: theme.colors.textSecondary, ...Typography.default() },
    input: { minHeight: 48, paddingHorizontal: 16, borderRadius: 8, marginBottom: 16, backgroundColor: theme.colors.input.background, color: theme.colors.input.text, ...Typography.default() },
    cancel: { alignSelf: 'center', marginTop: 16 },
}));

export default function Register() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const [invitation, setInvitation] = useState('');
    const [loading, setLoading] = useState(false);
    const registrationAllowed = canRegister(auth.isAuthenticated);

    useEffect(() => {
        if (!registrationAllowed) {
            router.replace('/');
        }
    }, [registrationAllowed, router]);

    const register = async () => {
        const code = invitation.trim();
        if (!registrationAllowed || !code || loading) {
            return;
        }

        setLoading(true);
        let secret: Uint8Array | undefined;
        try {
            secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret, code);
            await auth.login(token, encodeBase64(secret, 'base64url'));
            trackAccountCreated();
            router.replace('/');
        } catch {
            Modal.alert('Unable to create account', 'The invitation is invalid, expired, or already used.');
        } finally {
            if (secret) {
                secret.fill(0);
            }
            setInvitation('');
            setLoading(false);
        }
    };

    if (!registrationAllowed) {
        return null;
    }

    return (
        <View style={styles.container}>
            <View style={styles.content}>
                <Text style={styles.instruction}>Enter your invitation code to create a Chimera account.</Text>
                <TextInput
                    style={styles.input}
                    value={invitation}
                    onChangeText={setInvitation}
                    placeholder="Invitation code"
                    placeholderTextColor={theme.colors.input.placeholder}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    editable={!loading}
                />
                <RoundButton title="Create account" onPress={register} loading={loading} disabled={!invitation.trim()} />
                <RoundButton title="Cancel" size="normal" display="inverted" style={styles.cancel} onPress={() => router.back()} disabled={loading} />
            </View>
        </View>
    );
}
