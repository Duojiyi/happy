export function canRegister(isAuthenticated: boolean): boolean {
    return !isAuthenticated;
}
