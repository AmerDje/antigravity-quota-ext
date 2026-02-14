import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DISPLAY_UPDATE_INTERVAL_MS = 30 * 1000; // Update countdown every 30s instead of 1s

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
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('quota-view', quotaProvider),
    vscode.commands.registerCommand('quota-view.refreshEntry', () =>
      quotaProvider.manualRefresh(),
    ),
    { dispose: () => quotaProvider.dispose() },
  );
}

export function deactivate() {}

class QuotaProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private nextFetchTime = Date.now() + REFRESH_INTERVAL_MS;
  private cachedModels: ClientModelConfig[] = [];
  private timerInterval: NodeJS.Timeout | undefined;
  private isRefreshing = false;
  private lastError = false;

  constructor() {
    this.timerInterval = setInterval(() => {
      if (Date.now() >= this.nextFetchTime) {
        this.refresh();
      } else {
        // Only fire tree update for countdown display, not a full data refresh
        this._onDidChangeTreeData.fire();
      }
    }, DISPLAY_UPDATE_INTERVAL_MS);
  }

  dispose() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
  }

  async manualRefresh() {
    await this.refresh();
  }

  async refresh() {
    if (this.isRefreshing) {
      return;
    }
    this.isRefreshing = true;
    this.nextFetchTime = Date.now() + REFRESH_INTERVAL_MS;
    try {
      const models = await this.fetchQuotas();
      if (models.length > 0) {
        this.cachedModels = models;
        this.lastError = false;
      } else if (this.cachedModels.length === 0) {
        this.lastError = true;
      }
    } catch (e) {
      console.error('Failed to refresh quotas:', e);
      this.lastError = true;
    } finally {
      this.isRefreshing = false;
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem) {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];
    if (this.cachedModels.length === 0 && !this.isRefreshing) {
      // Don't await here to avoid blocking, just trigger background refresh
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

    // Show error state when no data is available
    if (this.cachedModels.length === 0 && this.lastError) {
      const errorItem = new vscode.TreeItem('Unable to fetch quotas');
      errorItem.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('charts.yellow'),
      );
      errorItem.tooltip =
        'Could not reach the language server. Click the refresh button to retry.';
      return [timerItem, errorItem];
    }

    if (this.cachedModels.length === 0) {
      const loadingItem = new vscode.TreeItem('Loading quotas…');
      loadingItem.iconPath = new vscode.ThemeIcon('loading~spin');
      return [timerItem, loadingItem];
    }

    const modelItems = this.cachedModels.map((m) => {
      const perc = Math.round((m.quotaInfo?.remainingFraction ?? 1) * 100);
      const item = new vscode.TreeItem(m.label);

      let resetTimeDisplay = '';
      if (m.quotaInfo?.resetTime) {
        try {
          const date = new Date(m.quotaInfo.resetTime);
          if (!isNaN(date.getTime())) {
            resetTimeDisplay = date.toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            });
          }
        } catch (e) {
          /* ignore parse errors */
        }
      }

      item.description = `${perc}%${resetTimeDisplay ? ` • Resets ${resetTimeDisplay}` : ''}`;

      const filled = Math.round(perc / 10);
      item.tooltip = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${perc}%${resetTimeDisplay ? `\nResets at ${resetTimeDisplay}` : ''}`;

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
                  locale: vscode.env.language,
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
        // Use PowerShell Get-CimInstance instead of deprecated wmic
        const { stdout } = await execAsync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language_server*' -or $_.CommandLine -like '*language_server*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`,
        );

        const trimmed = stdout.trim();
        if (!trimmed || trimmed === '') {
          return null;
        }

        // PowerShell returns an object for 1 result, array for multiple
        let processes: Array<{ ProcessId: number; CommandLine: string }>;
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          processes = parsed;
        } else {
          processes = [parsed];
        }

        for (const proc of processes) {
          const pid = String(proc.ProcessId);
          const commandLine = proc.CommandLine || '';

          if (commandLine && pid && /^\d+$/.test(pid)) {
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
        if (!pid || !/^\d+$/.test(pid)) return null;

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
    // Validate PID to prevent shell injection
    if (!/^\d+$/.test(pid)) {
      return [];
    }

    const isWindows = process.platform === 'win32';
    try {
      if (isWindows) {
        // Windows: use netstat -ano and filter by PID in JS
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
