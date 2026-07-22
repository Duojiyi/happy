export async function loadFontsWithFallback(
    load: () => Promise<void>,
    warn: (message: string, error: unknown) => void = console.warn,
): Promise<void> {
    try {
        await load();
    } catch (error) {
        warn('Font loading failed; continuing with fallback fonts.', error);
    }
}
