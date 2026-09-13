import {ChildProcess, execFile} from 'node:child_process';
import {platform} from 'node:os';

import {PingConfig, PingResult} from '../cross/types';

export class Pinger {
  private readonly config: Required<PingConfig>;
  private readonly isWindows: boolean;
  private readonly historySize: number;
  private running: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private activeProcess: ChildProcess | null = null;
  private sampleHistory: Array<{timestamp: number; latency: number | null}> = [];

  public host: string;
  public isGateway: boolean;
  public label?: string;

  // Callbacks for consumers to handle the events
  public onResult?: (result: PingResult) => void;
  public onError?: (error: Error) => void;

  constructor(config: PingConfig) {
    this.host = config.host;
    this.isGateway = config.isGateway ?? false;
    this.label = config.label;
    this.historySize = config.historySize ?? 20;
    this.config = {
      host: config.host,
      intervalMs: config.intervalMs,
      timeoutMs: config.timeoutMs ?? 2000,
      historySize: this.historySize,
      isGateway: this.isGateway,
      label: this.label ?? '',
    };
    this.isWindows = platform() === 'win32';
  }

  /**
   * Starts the ping loop.
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  /**
   * Stops the ping loop.
   */
  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activeProcess) {
      try {
        this.activeProcess.kill();
      } catch {
        // Ignore kill errors if the process has already terminated
      }
      this.activeProcess = null;
    }
  }

  /**
   * Records a sample into the rolling window and calculates telemetry stats:
   * Packet loss % and Jitter (mean consecutive absolute latency difference in ms).
   */
  private recordSample(latency: number | null): {
    packetLoss: number;
    jitter: number;
    min?: number;
    max?: number;
    avg?: number;
  } {
    this.sampleHistory.push({timestamp: Date.now(), latency});
    if (this.sampleHistory.length > this.historySize) {
      this.sampleHistory.shift();
    }

    const total = this.sampleHistory.length;
    const dropped = this.sampleHistory.filter(s => s.latency === null).length;
    const packetLoss = total > 0 ? Math.round((dropped / total) * 100) : 0;

    const valid = this.sampleHistory.map(s => s.latency).filter((l): l is number => l !== null && l >= 0);

    let jitter = 0;
    if (valid.length >= 2) {
      let sumDiff = 0;
      for (let i = 1; i < valid.length; i++) {
        sumDiff += Math.abs(valid[i] - valid[i - 1]);
      }
      jitter = Math.round((sumDiff / (valid.length - 1)) * 10) / 10;
    }

    const min = valid.length > 0 ? Math.min(...valid) : undefined;
    const max = valid.length > 0 ? Math.max(...valid) : undefined;
    const avg = valid.length > 0 ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10 : undefined;

    return {packetLoss, jitter, min, max, avg};
  }

  /**
   * Recursive loop to ensure pings do not overlap if the response
   * takes longer than the specified interval.
   */
  private async loop(): Promise<void> {
    if (!this.running) return;

    const startTime = Date.now();
    try {
      const result = await this.ping();
      if (this.running && this.onResult) {
        this.onResult(result);
      }
    } catch (err) {
      this.recordSample(null);
      if (this.running && this.onError) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }

    const elapsed = Date.now() - startTime;
    const delay = Math.max(0, this.config.intervalMs - elapsed);

    if (this.running) {
      this.timer = setTimeout(() => this.loop(), delay);
    }
  }

  /**
   * Executes a single ping command and parses the output.
   */
  private ping(): Promise<PingResult> {
    return new Promise(resolve => {
      const timestamp = new Date();
      const host = this.config.host.trim();
      const args = this.buildArgs(host);

      const child = execFile('ping', args, {windowsHide: true}, (error, stdout, stderr) => {
        this.activeProcess = null;

        const result: PingResult = {
          host: this.config.host,
          alive: false,
          timestamp,
        };

        if (error) {
          const stats = this.recordSample(null);
          result.error = stderr || error.message;
          result.rawOutput = stdout;
          result.packetLoss = stats.packetLoss;
          result.jitter = stats.jitter;
          result.min = stats.min;
          result.max = stats.max;
          result.avg = stats.avg;
          result.isGateway = this.isGateway;
          result.label = this.label;
          return resolve(result);
        }

        const latency = this.parseLatency(stdout);
        const stats = this.recordSample(latency);

        result.packetLoss = stats.packetLoss;
        result.jitter = stats.jitter;
        result.min = stats.min;
        result.max = stats.max;
        result.avg = stats.avg;
        result.isGateway = this.isGateway;
        result.label = this.label;

        if (latency !== null) {
          result.alive = true;
          result.latency = latency;
        } else {
          result.alive = false;
          result.rawOutput = stdout;
        }

        resolve(result);
      });

      this.activeProcess = child;
    });
  }

  /**
   * Generates the appropriate OS-specific ping arguments.
   */
  private buildArgs(host: string): string[] {
    const {timeoutMs} = this.config;

    if (this.isWindows) {
      // -n 1: send 1 packet
      // -w: timeout in milliseconds
      return ['-n', '1', '-w', String(timeoutMs), host];
    } else {
      // -c 1: send 1 packet
      // -W: timeout in seconds (rounded up to avoid 0)
      const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
      return ['-c', '1', '-W', String(timeoutSec), host];
    }
  }

  /**
   * Extract latency in milliseconds from standard ping output.
   */
  private parseLatency(stdout: string): number | null {
    // Regex matches common patterns like: "time=14.2 ms", "time=12ms", "time<1ms"
    const match = /time[=<]([\d.]+)\s*ms/i.exec(stdout);
    if (match && match[1]) {
      const parsed = parseFloat(match[1]);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  }
}
