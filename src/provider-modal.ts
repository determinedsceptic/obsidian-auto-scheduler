import { Modal, Notice, Setting, requestUrl } from 'obsidian';
import type AutoScheduler from './main';
import type { ProviderConfig } from './types';
import { PROVIDER_TEMPLATES, discoverModels, validateProvider, modelChoices } from './providers';
import { endpoint } from './llm';
export class ProviderModal extends Modal {
  private draft: ProviderConfig;
  private selectedModel: string;
  private token = '';
  private clearKey = false;
  private discovered: string[] = [];
  private busy = false;
  private closed = false;
  private status = '';
  private rejectedBinding = '';
  constructor(private plugin: AutoScheduler, private existing?: ProviderConfig, private done?: () => void) {
    super(plugin.app);
    this.draft = existing ? structuredClone(existing) : { id: crypto.randomUUID().replace(/-/g, ''), ...PROVIDER_TEMPLATES.openai };
    this.selectedModel = existing && plugin.byok.activeProviderId === existing.id && existing.models.includes(plugin.byok.activeModel)
      ? plugin.byok.activeModel : this.draft.models[0] ?? '';
  }
  onOpen(): void { this.render(); if (this.existing) void this.test(); }
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
      d.onChange(value => { this.draft = { id: this.draft.id, ...PROVIDER_TEMPLATES[value], models: [...PROVIDER_TEMPLATES[value].models] }; this.selectedModel = this.draft.models[0] ?? ''; this.token = ''; this.clearKey = false; this.discovered = []; this.status = ''; this.render(); });
    });
    new Setting(root).setName('Display name').addText(t => t.setValue(this.draft.name).onChange(v => { this.draft.name = v.trim(); }));
    new Setting(root).setName('Protocol').addDropdown(d => d.addOption('responses', 'OpenAI Responses').addOption('chat-completions', 'OpenAI-compatible Chat Completions').addOption('anthropic', 'Anthropic Messages').addOption('gemini', 'Google Gemini').setValue(this.draft.protocol).onChange(v => { this.draft.protocol = v as ProviderConfig['protocol']; this.token = ''; this.discovered = []; this.status = 'Protocol changed. Re-enter your key; the saved key will not be sent to the new endpoint.'; this.render(); }));
    new Setting(root).setName('Base URL').setDesc('Root URL without /responses, /messages, or /chat/completions. Re-enter the key after changing the address.').addText(t => t.setValue(this.draft.baseUrl).onChange(v => { this.draft.baseUrl = v.trim(); this.token = ''; this.discovered = []; this.status = 'Address changed. The saved key will not be sent to the new address.'; tokenInput.value = ''; }));
    new Setting(root).setName('Requires API key').setDesc('Turn off for local services such as Ollama or LM Studio.').addToggle(t => t.setValue(this.draft.requiresKey).onChange(v => { this.draft.requiresKey = v; }));
    let tokenInput: HTMLInputElement;
    new Setting(root).setName('API key').setDesc(`${this.plugin.credentials.mode}. Leave empty to keep the key if address and protocol are unchanged; enter a new key to replace it.`).addText(t => {
      tokenInput = t.inputEl; t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off';
      t.setValue(this.token).onChange(v => { this.token = v; if (v) this.clearKey = false; });
      t.inputEl.addEventListener('blur', () => { if (this.token.trim() && !this.busy) void this.test(); });
    });
    new Setting(root).setName('Clear API key').setDesc('Only clears this provider key when you save.').addToggle(t => t.setValue(this.clearKey).onChange(v => { this.clearKey = v; if (v) { this.token = ''; tokenInput.value = ''; } }));
    const test = root.createEl('button', { text: 'Refresh model list' }); test.disabled = this.busy;
    test.addEventListener('click', () => { void this.test(); });
    root.createEl('p', { text: this.status || 'Testing requests the model list, not an inference. A successful list does not guarantee tool calling.', attr: { 'aria-live': 'polite' } });
    let modelSelect: HTMLSelectElement;
    const refreshModels = (): void => {
      const choices = modelChoices(this.draft, this.discovered);
      if (!choices.includes(this.selectedModel)) this.selectedModel = choices[0] ?? '';
      modelSelect.replaceChildren();
      if (!choices.length) modelSelect.createEl('option', { text: 'Refresh model list to choose a model', value: '' });
      for (const model of choices) modelSelect.createEl('option', { text: model, value: model });
      modelSelect.value = this.selectedModel;
      modelSelect.disabled = this.busy || !choices.length;
    };
    new Setting(root).setName('Model for chat').setDesc('Select from preset, saved or discovered models. Refresh the model list above to load models from your provider.').addDropdown(d => {
      modelSelect = d.selectEl;
      d.onChange(value => { this.selectedModel = value; });
    });
    refreshModels();
    const advanced = root.createEl('details');
    advanced.createEl('summary', { text: 'Advanced: custom model IDs' });
    new Setting(advanced).setName('Custom model IDs').setDesc('Optional fallback when your provider cannot return a model list. One ID per line.').addTextArea(t => {
      t.inputEl.rows = 3; t.setValue(this.draft.models.join('\n')).onChange(v => { this.draft.models = [...new Set(v.split(/\r?\n/).map(s => s.trim()).filter(Boolean))]; refreshModels(); });
    });
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
      if (!this.selectedModel || !modelChoices(this.draft, this.discovered).includes(this.selectedModel)) throw new Error('Refresh the model list and select a model first');
      this.draft.models = [...new Set([this.selectedModel, ...this.draft.models, ...this.discovered])].slice(0, 1000);
      validateProvider(this.draft); endpoint({ ...this.draft, model: this.draft.models[0] });
      const key = await this.candidateKey();
      if (this.draft.requiresKey && !key) throw new Error('This provider requires an API key');
      if (this.binding(key) === this.rejectedBinding) throw new Error('Authentication rejected for this key. Correct it before saving.');
      await this.plugin.saveProvider(structuredClone(this.draft), key, this.selectedModel);
      this.done?.(); this.close();
    } catch (error) { new Notice((error as Error).message); }
    finally { this.busy = false; this.render(); }
  }
}
