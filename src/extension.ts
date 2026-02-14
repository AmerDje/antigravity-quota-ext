import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function activate(context: vscode.ExtensionContext) {
    const quotaProvider = new QuotaProvider();
    vscode.window.registerTreeDataProvider('quota-view', quotaProvider);
    context.subscriptions.push(vscode.commands.registerCommand('quota-view.refreshEntry', () => quotaProvider.manualRefresh()));
}

class QuotaProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private nextFetchTime = Date.now() + REFRESH_INTERVAL_MS;
    private cachedModels: any[] = [];

    constructor() {
        setInterval(() => {
            this._onDidChangeTreeData.fire();
            if (Date.now() >= this.nextFetchTime) { this.refresh(); }
        }, 1000);
    }

    async manualRefresh() { await this.refresh(); this.nextFetchTime = Date.now() + REFRESH_INTERVAL_MS; }

    async refresh() {
        try { this.cachedModels = await this.fetchQuotas(); this.nextFetchTime = Date.now() + REFRESH_INTERVAL_MS; }
        catch (e) { console.error(e); }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem) { return element; }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element) return [];
        if (this.cachedModels.length === 0) await this.refresh();
        
        const secondsLeft = Math.max(0, Math.floor((this.nextFetchTime - Date.now()) / 1000));
        const timerItem = new vscode.TreeItem(`Next check in: ${Math.floor(secondsLeft/60)}:${(secondsLeft%60).toString().padStart(2,'0')}`);
        timerItem.iconPath = new vscode.ThemeIcon('watch');

        const modelItems = this.cachedModels.map(m => {
            const perc = Math.round((m.quotaInfo?.remainingFraction ?? 1) * 100);
            const item = new vscode.TreeItem(m.label);
            item.description = `${perc}% remaining`;
            const filled = Math.round(perc / 10);
            item.tooltip = `${'█'.repeat(filled)}${'░'.repeat(10-filled)} ${perc}%\nResets: ${m.quotaInfo?.resetTime || 'N/A'}`;
            item.iconPath = new vscode.ThemeIcon(perc > 50 ? 'check' : (perc > 20 ? 'warning' : 'error'), 
                new vscode.ThemeColor(perc > 50 ? 'charts.green' : (perc > 20 ? 'charts.yellow' : 'charts.red')));
            return item;
        });
        retutimerItem, ...modelItems];
    }

    private async fetchQuotas(): Promise<any[]> {
        try {
            const { stdout: psOut } = await execAsync("ps aux | grep language_server | grep -v grep");
            const line = psOut.split('\n')[0];
            const pid = line.trim().split(/\s+/)[1];
            const csrf = (line.match(/--csrf_token\s+([^\s]+)/) || line.match(/--csrf_token=([^\s]+)/))?.[1] || "";
            const { stdout: lsofOut } = await execAsync(`lsof -nP -a -p ${pid} -iTCP -sTCP:LISTEN`);
            const ports = [...new Set(lsofOut.match(/:(\d+)\s+\(LISTEN\)/g)?.map(p => p.match(/:(\d+)/)![1]))];
            for (const port of ports) {
                const res = await fetch(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
                    method: 'POST', headers: { 'X-Codeium-Csrf-Token': csrf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } })
                });
                if (res.ok) return ((await res.json()) as any).userStatus.cascadeModelConfigData.clientModelConfigs;
            }
        } catch (e) { }
        return [];
    }
}