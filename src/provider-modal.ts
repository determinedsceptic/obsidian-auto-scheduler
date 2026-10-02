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
    root.createEl('h2', { text: this.existing ? '编辑服务商' : '添加服务商' });
    if (!this.existing) new Setting(root).setName('服务商模板').addDropdown(d => {
      for (const [id, t] of Object.entries(PROVIDER_TEMPLATES)) d.addOption(id, t.name);
      d.setValue(Object.keys(PROVIDER_TEMPLATES).find(k => PROVIDER_TEMPLATES[k].name === this.draft.name) || 'custom');
      d.onChange(value => { this.draft = { id: this.draft.id, ...PROVIDER_TEMPLATES[value], models: [...PROVIDER_TEMPLATES[value].models] }; this.token = ''; this.clearKey = false; this.discovered = []; this.status = ''; this.render(); });
    });
    new Setting(root).setName('显示名称').addText(t => t.setValue(this.draft.name).onChange(v => { this.draft.name = v.trim(); }));
    new Setting(root).setName('接口协议').addDropdown(d => d.addOption('responses', 'OpenAI Responses').addOption('chat-completions', 'OpenAI 兼容 Chat Completions').addOption('anthropic', 'Anthropic Messages').addOption('gemini', 'Google Gemini').setValue(this.draft.protocol).onChange(v => { this.draft.protocol = v as ProviderConfig['protocol']; this.token = ''; this.discovered = []; this.status = '协议已变更，原令牌不会发送到新接口，请重新输入。'; this.render(); }));
    new Setting(root).setName('Base URL').setDesc('填写根地址，不含 /responses、/messages 或 /chat/completions；更换地址后需重新输入令牌。').addText(t => t.setValue(this.draft.baseUrl).onChange(v => { this.draft.baseUrl = v.trim(); this.token = ''; this.discovered = []; this.status = '地址已变更，原令牌不会发送到新地址。'; tokenInput.value = ''; }));
    new Setting(root).setName('需要 API 令牌').setDesc('Ollama、LM Studio 等本地服务可关闭。').addToggle(t => t.setValue(this.draft.requiresKey).onChange(v => { this.draft.requiresKey = v; }));
    let tokenInput: HTMLInputElement;
    new Setting(root).setName('API 令牌').setDesc(`${this.plugin.credentials.mode}。留空保留原令牌（地址和协议未变时）；输入新令牌替换。`).addText(t => {
      tokenInput = t.inputEl; t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off';
      t.setValue(this.token).onChange(v => { this.token = v; if (v) this.clearKey = false; });
    });
    new Setting(root).setName('清除令牌').setDesc('只在点击保存时清除本服务商令牌。').addToggle(t => t.setValue(this.clearKey).onChange(v => { this.clearKey = v; if (v) { this.token = ''; tokenInput.value = ''; } }));
    const test = root.createEl('button', { text: '测试连接并发现模型' }); test.disabled = this.busy;
    test.addEventListener('click', () => { void this.test(); });
    root.createEl('p', { text: this.status || '连接测试使用模型列表接口，不产生推理请求；模型列表成功不保证工具调用可用。', attr: { 'aria-live': 'polite' } });
    let modelInput: HTMLTextAreaElement;
    new Setting(root).setName('模型 ID').setDesc('每行一个，支持手动填写；模型发现失败仍可保存离线配置。').addTextArea(t => {
      modelInput = t.inputEl; t.inputEl.rows = 4; t.setValue(this.draft.models.join('\n')).onChange(v => { this.draft.models = [...new Set(v.split(/\r?\n/).map(s => s.trim()).filter(Boolean))]; });
    });
    if (this.discovered.length) {
      const list = root.createDiv({ cls: 'auto-scheduler-model-list' });
      const display = (): void => { list.empty(); const choices = this.discovered.filter(m => m.toLowerCase().includes(this.search.toLowerCase())).slice(0, 100);
        for (const model of choices) new Setting(list).setName(model).addToggle(t => t.setValue(this.draft.models.includes(model)).onChange(v => { this.draft.models = v ? [...new Set([...this.draft.models, model])] : this.draft.models.filter(m => m !== model); modelInput.value = this.draft.models.join('\n'); }));
      };
      new Setting(root).setName('搜索已发现模型').setDesc('最多显示100项，筛选后选择需要的模型。').addText(t => t.setValue(this.search).onChange(v => { this.search = v; display(); })); display();
    }
    const actions = root.createDiv({ cls: 'auto-scheduler-actions' });
    const save = actions.createEl('button', { text: '保存服务商', cls: 'mod-cta' }); save.disabled = this.busy;
    save.addEventListener('click', () => { void this.save(); });
    actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    for (const field of Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'))) field.disabled = this.busy;
  }
  private async test(): Promise<void> {
    this.busy = true; this.render();
    try {
      const key = await this.candidateKey(); const draft = structuredClone(this.draft); const binding = this.binding(key);
      this.status = '正在连接…'; this.render();
      try {
        const result = await discoverModels(draft, key, async (url, headers) => { const r = await requestUrl({ url, method: 'GET', headers, throw: false }); return { status: r.status, json: r.status >= 200 && r.status < 300 ? r.json : {} }; });
        this.discovered = result.models; this.status = result.note; this.rejectedBinding = '';
      } catch (error) { this.status = (error as Error).message; if (this.status.includes('拒绝鉴权')) this.rejectedBinding = binding; }
    } catch (error) { this.status = (error as Error).message; }
    finally { this.busy = false; this.render(); }
  }
  private async save(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try {
      validateProvider(this.draft); endpoint({ ...this.draft, model: this.draft.models[0] });
      const key = await this.candidateKey();
      if (this.draft.requiresKey && !key) throw new Error('需要 API 令牌的服务商必须填写令牌');
      if (this.binding(key) === this.rejectedBinding) throw new Error('当前令牌测试已被拒绝，请更正后再保存');
      await this.plugin.saveProvider(structuredClone(this.draft), key);
      this.done?.(); this.close();
    } catch (error) { new Notice((error as Error).message); }
    finally { this.busy = false; this.render(); }
  }
}
