import {exec, execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {TopProcessesData, TopProcessItem} from '../cross/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 3000;
const ACTIVE_POLL_INTERVAL_MS = 3500;

const WIN_POWERSHELL_SCRIPT = `
$procMap = @{}
Get-Process | ForEach-Object { $procMap[$_.Id] = @{ name = $_.ProcessName; ws = $_.WorkingSet64 } }

$perfProcs = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -notin "_Total", "Idle" }

$cpuCores = [System.Environment]::ProcessorCount
if (-not $cpuCores -or $cpuCores -le 0) { $cpuCores = 1 }

$cpuList = @($perfProcs | ForEach-Object {
    $pidNum = [int]$_.IDProcess
    $pInfo = $procMap[$pidNum]
    $cleanName = if ($pInfo -and $pInfo.name) { $pInfo.name } else { ($_.Name -replace "#\\d+$","") }
    $cpuPct = [math]::Round(([double]$_.PercentProcessorTime) / $cpuCores, 1)
    $memBytes = if ($pInfo -and $pInfo.ws) { [int64]$pInfo.ws } else { [int64]$_.WorkingSetPrivate }
    [PSCustomObject]@{
        pid = $pidNum
        name = $cleanName
        cpu = $cpuPct
        memory = $memBytes
    }
} | Sort-Object cpu -Descending | Select-Object -First 3)

$memList = @($perfProcs | ForEach-Object {
    $pidNum = [int]$_.IDProcess
    $pInfo = $procMap[$pidNum]
    $cleanName = if ($pInfo -and $pInfo.name) { $pInfo.name } else { ($_.Name -replace "#\\d+$","") }
    $cpuPct = [math]::Round(([double]$_.PercentProcessorTime) / $cpuCores, 1)
    $memBytes = if ($pInfo -and $pInfo.ws) { [int64]$pInfo.ws } else { [int64]$_.WorkingSetPrivate }
    [PSCustomObject]@{
        pid = $pidNum
        name = $cleanName
        cpu = $cpuPct
        memory = $memBytes
    }
} | Sort-Object memory -Descending | Select-Object -First 3)

$gpuMemMap = @{}
try {
  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction SilentlyContinue |
    Where-Object { $_.DedicatedUsage -gt 0 } |
    ForEach-Object {
      if ($_.Name -match "pid_(\\d+)_") {
          $p = [int]$matches[1]
          $gpuMemMap[$p] = ($gpuMemMap[$p] -as [int64]) + [int64]$_.DedicatedUsage
      }
  }
} catch {}

$gpuEngMap = @{}
try {
  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue |
    Where-Object { $_.UtilizationPercentage -gt 0 } |
    ForEach-Object {
      if ($_.Name -match "pid_(\\d+)_") {
          $p = [int]$matches[1]
          $gpuEngMap[$p] = ($gpuEngMap[$p] -as [double]) + [double]$_.UtilizationPercentage
      }
  }
} catch {}

$allGpuPids = [System.Collections.Generic.HashSet[int]]::new()
foreach ($p in $gpuMemMap.Keys) { [void]$allGpuPids.Add($p) }
foreach ($p in $gpuEngMap.Keys) { [void]$allGpuPids.Add($p) }

$gpuList = @($allGpuPids | ForEach-Object {
    $pidNum = $_
    $pInfo = $procMap[$pidNum]
    $cleanName = if ($pInfo -and $pInfo.name) { $pInfo.name } else { "PID $pidNum" }
    $gpuPct = if ($gpuEngMap[$pidNum]) { [math]::Round($gpuEngMap[$pidNum], 1) } else { 0 }
    $vramBytes = if ($gpuMemMap[$pidNum]) { $gpuMemMap[$pidNum] } else { 0 }
    [PSCustomObject]@{
        pid = $pidNum
        name = $cleanName
        gpu = $gpuPct
        vram = $vramBytes
    }
} | Sort-Object -Property @{Expression="gpu"; Descending=$true}, @{Expression="vram"; Descending=$true} |
    Select-Object -First 3)

@{ cpu = $cpuList; memory = $memList; gpu = $gpuList } | ConvertTo-Json -Compress
`.trim();

/**
 * Service to sample top resource-consuming processes (CPU, GPU, RAM)
 * with caching and on-demand polling lifecycle.
 */
export class ProcessMonitorService {
  private static instance: ProcessMonitorService;

  private cachedData?: TopProcessesData;
  private lastSampleTime = 0;
  private activeSamplingInterval?: NodeJS.Timeout;
  private pendingSamplePromise?: Promise<TopProcessesData>;
  private updateListeners: Array<(data: TopProcessesData) => void> = [];

  private constructor() {}

  public static getInstance(): ProcessMonitorService {
    if (!ProcessMonitorService.instance) {
      ProcessMonitorService.instance = new ProcessMonitorService();
    }
    return ProcessMonitorService.instance;
  }

  public getCachedData(): TopProcessesData | undefined {
    return this.cachedData;
  }

  /**
   * Samples top processes with cache-first behavior.
   */
  public async sampleTopProcesses(force = false): Promise<TopProcessesData> {
    const now = Date.now();
    if (!force && this.cachedData && now - this.lastSampleTime < CACHE_TTL_MS) {
      return this.cachedData;
    }

    if (this.pendingSamplePromise) {
      return this.pendingSamplePromise;
    }

    this.pendingSamplePromise = this.performSample()
      .then(data => {
        this.cachedData = data;
        this.lastSampleTime = Date.now();
        this.notifyListeners(data);
        return data;
      })
      .catch(err => {
        console.error('[ProcessMonitorService] Error sampling processes:', err);
        const fallback: TopProcessesData = this.cachedData || {
          cpu: [],
          gpu: [],
          memory: [],
          timestamp: Date.now(),
        };
        return fallback;
      })
      .finally(() => {
        this.pendingSamplePromise = undefined;
      });

    return this.pendingSamplePromise;
  }

  /**
   * Starts active sampling for when a flyout is currently open.
   * Immediately polls once, then continues on interval.
   */
  public startActiveSampling(callback?: (data: TopProcessesData) => void): () => void {
    if (callback && !this.updateListeners.includes(callback)) {
      this.updateListeners.push(callback);
      if (this.cachedData) {
        callback(this.cachedData);
      }
    }

    // Trigger immediate sample
    void this.sampleTopProcesses();

    if (!this.activeSamplingInterval) {
      this.activeSamplingInterval = setInterval(() => {
        void this.sampleTopProcesses(true);
      }, ACTIVE_POLL_INTERVAL_MS);
    }

    return () => {
      if (callback) {
        this.updateListeners = this.updateListeners.filter(cb => cb !== callback);
      }
      if (this.updateListeners.length === 0) {
        this.stopActiveSampling();
      }
    };
  }

  /**
   * Stops active sampling immediately to ensure zero idle overhead.
   */
  public stopActiveSampling(): void {
    if (this.activeSamplingInterval) {
      clearInterval(this.activeSamplingInterval);
      this.activeSamplingInterval = undefined;
    }
    this.updateListeners = [];
  }

  private notifyListeners(data: TopProcessesData): void {
    this.updateListeners.forEach(listener => {
      try {
        listener(data);
      } catch (err) {
        console.error('[ProcessMonitorService] Listener error:', err);
      }
    });
  }

  private async performSample(): Promise<TopProcessesData> {
    const platform = process.platform;
    if (platform === 'win32') {
      return this.sampleWindows();
    }
    if (platform === 'linux') {
      return this.sampleLinux();
    }
    if (platform === 'darwin') {
      return this.sampleMac();
    }

    return {
      cpu: [],
      gpu: [],
      memory: [],
      timestamp: Date.now(),
    };
  }

  private async sampleWindows(): Promise<TopProcessesData> {
    try {
      const {stdout} = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_POWERSHELL_SCRIPT],
        {timeout: 4500, maxBuffer: 1024 * 1024},
      );

      const parsed = JSON.parse(stdout.trim());
      const normalize = (items: any[]): TopProcessItem[] => {
        if (!Array.isArray(items)) return [];
        return items.map(item => ({
          pid: Number(item.pid) || 0,
          name: String(item.name || 'Unknown'),
          cpu: typeof item.cpu === 'number' ? item.cpu : undefined,
          memory: typeof item.memory === 'number' ? item.memory : undefined,
          gpu: typeof item.gpu === 'number' ? item.gpu : undefined,
          vram: typeof item.vram === 'number' ? item.vram : undefined,
        }));
      };

      return {
        cpu: normalize(parsed.cpu),
        gpu: normalize(parsed.gpu),
        memory: normalize(parsed.memory),
        timestamp: Date.now(),
      };
    } catch (err) {
      console.error('[ProcessMonitorService] Windows sampling failed:', err);
      return {
        cpu: [],
        gpu: [],
        memory: [],
        timestamp: Date.now(),
      };
    }
  }

  private async sampleLinux(): Promise<TopProcessesData> {
    try {
      const [cpuOut, memOut, gpuData] = await Promise.all([
        execAsync('ps -eo pid,pcpu,pmem,rss,comm --sort=-pcpu | head -n 4', {timeout: 3000}),
        execAsync('ps -eo pid,pcpu,pmem,rss,comm --sort=-rss | head -n 4', {timeout: 3000}),
        this.sampleLinuxNvidiaGpu(),
      ]);

      const parsePs = (stdout: string): TopProcessItem[] => {
        const lines = stdout.trim().split('\n').slice(1);
        const results: TopProcessItem[] = [];
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 5) continue;
          const pid = parseInt(parts[0], 10);
          const cpu = parseFloat(parts[1]);
          const rssKb = parseInt(parts[3], 10);
          const name = parts.slice(4).join(' ');
          results.push({
            pid,
            name,
            cpu: isNaN(cpu) ? 0 : cpu,
            memory: isNaN(rssKb) ? 0 : rssKb * 1024,
          });
        }
        return results;
      };

      return {
        cpu: parsePs(cpuOut.stdout),
        memory: parsePs(memOut.stdout),
        gpu: gpuData,
        timestamp: Date.now(),
      };
    } catch (err) {
      console.error('[ProcessMonitorService] Linux sampling failed:', err);
      return {
        cpu: [],
        gpu: [],
        memory: [],
        timestamp: Date.now(),
      };
    }
  }

  private async sampleLinuxNvidiaGpu(): Promise<TopProcessItem[]> {
    try {
      const {stdout} = await execAsync(
        'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits',
        {timeout: 2500},
      );
      const lines = stdout.trim().split('\n').filter(Boolean);
      return lines.slice(0, 3).map(line => {
        const [pidStr, nameStr, memStr] = line.split(',').map(s => s.trim());
        const pid = parseInt(pidStr, 10) || 0;
        const vramMb = parseFloat(memStr) || 0;
        const shortName = nameStr ? nameStr.split('/').pop() || nameStr : 'GPU Process';
        return {
          pid,
          name: shortName,
          gpu: 0,
          vram: vramMb * 1024 * 1024,
        };
      });
    } catch {
      return [];
    }
  }

  private async sampleMac(): Promise<TopProcessesData> {
    try {
      const [cpuOut, memOut] = await Promise.all([
        execAsync('ps -eo pid,pcpu,pmem,rss,comm -r | head -n 4', {timeout: 3000}),
        execAsync('ps -eo pid,pcpu,pmem,rss,comm -m | head -n 4', {timeout: 3000}),
      ]);

      const parsePs = (stdout: string): TopProcessItem[] => {
        const lines = stdout.trim().split('\n').slice(1);
        const results: TopProcessItem[] = [];
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 5) continue;
          const pid = parseInt(parts[0], 10);
          const cpu = parseFloat(parts[1]);
          const rssKb = parseInt(parts[3], 10);
          const rawName = parts.slice(4).join(' ');
          const name = rawName.split('/').pop() || rawName;
          results.push({
            pid,
            name,
            cpu: isNaN(cpu) ? 0 : cpu,
            memory: isNaN(rssKb) ? 0 : rssKb * 1024,
          });
        }
        return results;
      };

      return {
        cpu: parsePs(cpuOut.stdout),
        memory: parsePs(memOut.stdout),
        gpu: [],
        timestamp: Date.now(),
      };
    } catch (err) {
      console.error('[ProcessMonitorService] Mac sampling failed:', err);
      return {
        cpu: [],
        gpu: [],
        memory: [],
        timestamp: Date.now(),
      };
    }
  }
}

export const processMonitorService = ProcessMonitorService.getInstance();
