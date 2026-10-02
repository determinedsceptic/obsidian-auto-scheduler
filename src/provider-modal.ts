import { Modal, Notice, Setting, requestUrl } from 'obsidian';
import type AutoScheduler from './main';
import type { ProviderConfig } from './types';
import { PROVIDER_TEMPLATES, discoverModels, validateProvider } from './providers';
import { endpoint } from './llm';
export class ProviderModal extends Modal {
  private draft: ProviderConfig;
  private token = '';
  private clearKey = false;
  private discovered: string[] = [];
  private search = '';
  private busy = false;
  private closed = false;
  private status = '';
  private rejectedBinding = '';
  constructor(private plugin: AutoScheduler, private existing?: ProviderConfig, private done?: () => void) {
    super(plugin.app);
    this.draft = existing ? structuredClone(existing) : { id: crypto.randomUUID().replace(/-/g, ''), ...PROVIDER_TEMPLATES.openai };
  }
  onOpen(): void { this.render(); }
  onClose(): void { this.closed = true; this.token = ''; this.contentEl.empty(); }
  private routeSame(): boolean { return !!this.existing && this.existing.protocol === this.draft.protocol && this.existing.baseUrl === this.draft.baseUrl; }
  private async candidateKey(): Promise<string> { return this.clearKey ? '' : this.token.trim() || (this.routeSame() ? await this.plugin.credentials.get(this.draft.id) : ''); }
  private binding(key: string): string { return JSON.stringify([this.draft.protocol, this.draft.baseUrl, key]); }
  private render(): void {
    if (this.closed) return;
    const root = this.contentEl; root.empty();
    root.createEl('h2', { text: this.existing ? 'Edit provider' : 'Add provider' });
    if (!this.existing) new Setting(root).setName('Provider template').addDropdown(d => {
      for (const [id, t] of Object.entries(PROVIDER_TEMPLATES)) d.addOption(id, t.name);
      d.setValue(Object.keys(PROVIDER_TEMPLATES).find(k => PROVIDER_TEMPLATES[k].name === this.draft.name) || 'custom');
      d.onChange(value => { this.draft = { id: this.draft.id, ...PROVIDER_TEMPLATES[value], models: [...PROVIDER_TEMPLATES[value].models] }; this.token = ''; this.clearKey = false; this.discovered = []; this.status = ''; this.render(); });
    });
    new Setting(root).setName('Display name').addText(t => t.setValue(this.draft.name).onChange(v => { this.draft.name = v.trim(); }));
    new Setting(root).setName('Protocol').addDropdown(d => d.addOption('responses', 'OpenAI Responses').addOption('chat-completions', 'OpenAI-compatible Chat Completions').addOption('anthropic', 'Anthropic Messages').addOption('gemini', 'Google Gemini').setValue(this.draft.protocol).onChange(v => { this.draft.protocol = v as ProviderConfig['protocol']; this.token = ''; this.discovered = []; this.status = 'Protocol changed. Re-enter your key; the saved key will not be sent to the new endpoint.'; this.render(); }));
    new Setting(root).setName('Base URL').setDesc('Root URL without /responses, /messages, or /chat/completions. Re-enter the key after changing the address.').addText(t => t.setValue(this.draft.baseUrl).onChange(v => { this.draft.baseUrl = v.trim(); this.token = ''; this.discovered = []; this.status = 'Address changed. The saved key will not be sent to the new address.'; tokenInput.value = ''; }));
    new Setting(root).setName('Requires API key').setDesc('Turn off for local services such as Ollama or LM Studio.').addToggle(t => t.setValue(this.draft.requiresKey).onChange(v => { this.draft.requiresKey = v; }));
    let tokenInput: HTMLInputElement;
    new Setting(root).setName('API key').setDesc(`${this.plugin.credentials.mode}. Leave empty to keep the key if address and protocol are unchanged; enter a new key to replace it.`).addText(t => {
      tokenInput = t.inputEl; t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off';
      t.setValue(this.token).onChange(v => { this.token = v; if (v) this.clearKey = false; });
    });
    new Setting(root).setName('Clear API key').setDesc('Only clears this provider key when you save.').addToggle(t => t.setValue(this.clearKey).onChange(v => { this.clearKey = v; if (v) { this.token = ''; tokenInput.value = ''; } }));
    const test = root.createEl('button', { text: 'Test connection and discover models' }); test.disabled = this.busy;
    test.addEventListener('click', () => { void this.test(); });
    root.createEl('p', { text: this.status || 'Testing requests the model list, not an inference. A successful list does not guarantee tool calling.', attr: { 'aria-live': 'polite' } });
    let modelInput: HTMLTextAreaElement;
    new Setting(root).setName('Model IDs').setDesc('One per line. Enter IDs manually if model discovery is unavailable.').addTextArea(t => {
      modelInput = t.inputEl; t.inputEl.rows = 4; t.setValue(this.draft.models.join('\n')).onChange(v => { this.draft.models = [...new Set(v.split(/\r?\n/).map(s => s.trim()).filter(Boolean))]; });
    });
    if (this.discovered.length) {
      const list = root.createDiv({ cls: 'auto-scheduler-model-list' });
      const display = (): void => { list.empty(); const choices = this.discovered.filter(m => m.toLowerCase().includes(this.search.toLowerCase())).slice(0, 100);
        for (const model of choices) new Setting(list).setName(model).addToggle(t => t.setValue(this.draft.models.includes(model)).onChange(v => { this.draft.models = v ? [...new Set([...this.draft.models, model])] : this.draft.models.filter(m => m !== model); modelInput.value = this.draft.models.join('\n'); }));
      };
      new Setting(root).setName('Search discovered models').setDesc('Shows up to 100 matches; filter and choose your models.').addText(t => t.setValue(this.search).onChange(v => { this.search = v; display(); })); display();
    }
    const actions = root.createDiv({ cls: 'auto-scheduler-actions' });
    const save = actions.createEl('button', { text: 'Save provider', cls: 'mod-cta' }); save.disabled = this.busy;
    save.addEventListener('click', () => { void this.save(); });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    for (const field of Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'))) field.disabled = this.busy;
  }
  private async test(): Promise<void> {
    this.busy = true; this.render();
    try {
      const key = await this.candidateKey(); const draft = structuredClone(this.draft); const binding = this.binding(key);
      this.status = 'Connecting…'; this.render();
      try {
        const result = await discoverModels(draft, key, async (url, headers) => { const r = await requestUrl({ url, method: 'GET', headers, throw: false }); return { status: r.status, json: r.status >= 200 && r.status < 300 ? r.json : {} }; });
        this.discovered = result.models; this.status = result.note; this.rejectedBinding = '';
      } catch (error) { this.status = (error as Error).message; if (this.status.includes('Authentication rejected')) this.rejectedBinding = binding; }
    } catch (error) { this.status = (error as Error).message; }
    finally { this.busy = false; this.render(); }
  }
  private async save(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try {
      validateProvider(this.draft); endpoint({ ...this.draft, model: this.draft.models[0] });
      const key = await this.candidateKey();
      if (this.draft.requiresKey && !key) throw new Error('This provider requires an API key');
      if (this.binding(key) === this.rejectedBinding) throw new Error('Authentication rejected for this key. Correct it before saving.');
      await this.plugin.saveProvider(structuredClone(this.draft), key);
      this.done?.(); this.close();
    } catch (error) { new Notice((error as Error).message); }
    finally { this.busy = false; this.render(); }
  }
}
