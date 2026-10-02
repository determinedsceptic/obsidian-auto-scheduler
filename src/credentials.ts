/** Public Obsidian SecretStorage is optional on older hosts. Never serialize secrets. */
export interface SecretPort { getSecret(id: string): string | null | Promise<string | null>; setSecret(id: string, value: string): void | Promise<void>; deleteSecret?(id: string): void | Promise<void> }
export class Credentials {
  private sessions = new Map<string, string>();
  constructor(private namespace: string, private storage?: SecretPort) {}
  get mode(): string { return this.storage ? 'Obsidian Keychain (on this device)' : 'Session memory (re-enter after reloading)'; }
  private id(providerId: string): string {
    if (!/^[a-z0-9-]{1,32}$/.test(providerId) || !/^[a-z0-9-]{1,32}$/.test(this.namespace)) throw new Error('Invalid credential ID');
    return `as-${this.namespace.slice(0, 16)}-${providerId}`;
  }
  async get(providerId: string): Promise<string> {
    const id = this.id(providerId);
    if (this.sessions.has(id)) return this.sessions.get(id)!;
    try { return (await this.storage?.getSecret(id)) ?? ''; } catch { throw new Error('Could not read Obsidian Keychain. Check your device Keychain or configure the provider again.'); }
  }
  async set(providerId: string, token: string): Promise<void> {
    const id = this.id(providerId); if (/[^\S ]|[\r\n]/.test(token)) throw new Error('API keys cannot contain control characters');
    try { if (this.storage) { if (!token && this.storage.deleteSecret) await this.storage.deleteSecret(id); else await this.storage.setSecret(id, token); this.sessions.delete(id); } else this.sessions.set(id, token); }
    catch { throw new Error('Could not save to Obsidian Keychain. The key was not saved as plain text.'); }
  }
  session(providerId: string, token: string): void { this.sessions.set(this.id(providerId), token); }
  clearSession(): void { this.sessions.clear(); }
}
