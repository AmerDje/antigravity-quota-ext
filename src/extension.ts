import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface QuotaInfo {
  remainingFraction: number;
  resetTime: string;
}

interface ClientModelConfig {
  label: string;
  quotaInfo: QuotaInfo;
}

export function activate(context: vscode.ExtensionContext) {
  const quotaProvider = new QuotaProvider();
  vscode.window.registerTreeDataProvider('quota-view', quotaProvider);
  context.subscriptions.push(
    vscode.commands.registerCommand('quota-view.refreshEntry', () =>
      quotaProvider.manualRefresh(),
    ),
  );
}

class QuotaProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private nextFetchTime = Date.now() + REFRESH_INTERVAL_MS;
  private cachedModels: ClientModelConfig[] = [];
  private timerInterval: NodeJS.Timeout | undefined;

  constructor() {
    this.timerInterval = setInterval(() => {
      this._onDidChangeTreeData.fire();
      if (Date.now() >= this.nextFetchTime) {
        this.refresh();
      }
    }, 1000);
  }

  dispose() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
  }

  async manualRefresh() {
    await this.refresh();
  }

  async refresh() {
    this.nextFetchTime = Date.now() + REFRESH_INTERVAL_MS;
    try {
      const models = await this.fetchQuotas();
      if (models.length > 0) {
        this.cachedModels = models;
      }
    } catch (e) {
      console.error('Failed to refresh quotas:', e);
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem) {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];
    if (this.cachedModels.length === 0) {
      // Don't await here to avoid blocking, just trigger background refresh if needed
      this.refresh();
    }

    const secondsLeft = Math.max(
      0,
      Math.floor((this.nextFetchTime - Date.now()) / 1000),
    );
    const timerItem = new vscode.TreeItem(
      `Next check in: ${Math.floor(secondsLeft / 60)}:${(secondsLeft % 60).toString().padStart(2, '0')}`,
    );
    timerItem.iconPath = new vscode.ThemeIcon('watch');

    const modelItems = this.cachedModels.map((m) => {
      const perc = Math.round((m.quotaInfo?.remainingFraction ?? 1) * 100);
      const item = new vscode.TreeItem(m.label);
      item.description = `${perc}% remaining`;
      const filled = Math.round(perc / 10);
      item.tooltip = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${perc}%\nResets: ${m.quotaInfo?.resetTime || 'N/A'}`;
      // Color logic: Green > 50, Yellow > 20, Red <= 20
      item.iconPath = new vscode.ThemeIcon(
        perc > 50 ? 'check' : perc > 20 ? 'warning' : 'error',
        new vscode.ThemeColor(
          perc > 50
            ? 'charts.green'
            : perc > 20
              ? 'charts.yellow'
              : 'charts.red',
        ),
      );
      return item;
    });

    return [timerItem, ...modelItems];
  }

  private async fetchQuotas(): Promise<ClientModelConfig[]> {
    try {
      const processInfo = await this.getProcessInfo();
      if (!processInfo) {
        console.log('Language server process not found.');
        return [];
      }

      const { pid, csrf } = processInfo;
      const ports = await this.getListeningPorts(pid);

      for (const port of ports) {
        try {
          const res = await fetch(
            `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
            {
              method: 'POST',
              headers: {
                'X-Codeium-Csrf-Token': csrf,
                'Connect-Protocol-Version': '1',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                metadata: {
                  ideName: 'antigravity',
                  extensionName: 'antigravity',
                  locale: 'en',
                },
              }),
            },
          );

          if (res.ok) {
            const data = (await res.json()) as any;
            return (
              data?.userStatus?.cascadeModelConfigData?.clientModelConfigs || []
            );
          }
        } catch (err) {
          console.warn(`Failed to fetch from port ${port}:`, err);
        }
      }
    } catch (e) {
      console.error('Error in fetchQuotas:', e);
    }
    return [];
  }

  private async getProcessInfo(): Promise<{
    pid: string;
    csrf: string;
  } | null> {
    const isWindows = process.platform === 'win32';

    try {
      if (isWindows) {
        // Windows: Use wmic to get commandserver process info
        // Look for processes with 'language_server' in command line
        const { stdout } = await execAsync(
          "wmic process where \"Name='language_server_windows_x64.exe' OR CommandLine like '%language_server%'\" get ProcessId,CommandLine /format:csv",
        );

        // Parse CSV output
        // Node,CommandLine,ProcessId
        const lines = stdout
          .trim()
          .split('\r\n')
          .filter((l) => l.trim().length > 0)
          .slice(1); // Skip header

        for (const line of lines) {
          // CSV parsing manual handling for potential quotes
          const parts = line.split(',');
          // format:csv output: Node,CommandLine,ProcessId.
          // Usually the last element is PID.
          const pid = parts[parts.length - 1]?.trim();
          const commandLine = parts.slice(1, parts.length - 1).join(',');

          if (commandLine && pid) {
            const csrf = this.extractCsrf(commandLine);
            return { pid, csrf };
          }
        }
      } else {
        // Unix/Linux/macOS
        const { stdout } = await execAsync(
          'ps aux | grep language_server | grep -v grep',
        );
        const line = stdout.split('\n')[0];
        if (!line) return null;

        const pid = line.trim().split(/\s+/)[1];
        const csrf = this.extractCsrf(line);
        return { pid, csrf };
      }
    } catch (e) {
      console.error('Failed to get process info:', e);
    }
    return null;
  }

  private extractCsrf(text: string): string {
    return (
      (text.match(/--csrf_token\s+([^\s]+)/) ||
        text.match(/--csrf_token=([^\s]+)/))?.[1] || ''
    );
  }

  private async getListeningPorts(pid: string): Promise<string[]> {
    const isWindows = process.platform === 'win32';
    try {
      if (isWindows) {
        // Windows: use netstat -ano
        // Filter by PID in JS to ensure exact match and avoid port collisions
        const { stdout } = await execAsync(`netstat -ano`);
        const ports = new Set<string>();

        const lines = stdout.split(/[\r\n]+/);
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          // Standard format: Proto Local Foreign State PID
          // TCP 127.0.0.1:1234 0.0.0.0:0 LISTENING 5678
          if (parts.length >= 5) {
            const protocol = parts[0];
            const localAddr = parts[1];
            const state = parts[3];
            const linePid = parts[4];

            if (
              protocol === 'TCP' &&
              state === 'LISTENING' &&
              linePid === pid
            ) {
              const portMatch = localAddr.match(/:(\d+)$/);
              if (portMatch) {
                ports.add(portMatch[1]);
              }
            }
          }
        }
        return Array.from(ports);
      } else {
        // Unix/Linux/macOS
        const { stdout: lsofOut } = await execAsync(
          `lsof -nP -a -p ${pid} -iTCP -sTCP:LISTEN`,
        );
        const matches = lsofOut.match(/:(\d+)\s+\(LISTEN\)/g);
        if (!matches) {
          return [];
        }
        return [...new Set(matches.map((p) => p.match(/:(\d+)/)![1]))];
      }
    } catch (e) {
      console.error('Failed to get ports:', e);
      return [];
    }
  }
}
