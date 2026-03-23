export interface PlatformAdapter {
    loadSpec(): Promise<any>;
    getAuthTemplate(): string;
    getEnvVarTemplate(): string;
}
