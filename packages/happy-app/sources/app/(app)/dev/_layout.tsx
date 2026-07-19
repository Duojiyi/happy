import { Redirect, Slot } from 'expo-router';

export default function DevLayout() {
    return __DEV__ ? <Slot /> : <Redirect href="/" />;
}
