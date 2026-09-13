import {networkInterfaces} from 'node:os';

import {PublicNetworkInfo} from '../cross/types';

const VPN_KEYWORDS = [
  'vpn',
  'wireguard',
  'wintun',
  'openvpn',
  'tun',
  'tap',
  'nordlynx',
  'proton',
  'tailscale',
  'zerotier',
  'surfshark',
  'expressvpn',
  'mullvad',
  'warp',
  'sing-box',
  'clash',
  'anyconnect',
  'fortinet',
  'cisco',
  'neorouter',
  'hamachi',
];
const VPN_INTERFACE_PATTERN = new RegExp(`(${VPN_KEYWORDS.join('|')})`, 'i');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const INTERFACE_CHECK_INTERVAL_MS = 15 * 1000; // 15 seconds

/**
 * Service to resolve public IP, country, city, ISP name, and active VPN/proxy tunnel status.
 */
export class PublicNetworkService {
  private static instance: PublicNetworkService;

  private cachedInfo?: PublicNetworkInfo;
  private lastFetchTime = 0;
  private isFetching = false;
  private pendingFetchPromise?: Promise<PublicNetworkInfo>;
  private checkIntervalTimer?: NodeJS.Timeout;
  private lastInterfaceFingerprint = '';
  private listeners: Array<(info: PublicNetworkInfo) => void> = [];

  private constructor() {}

  public static getInstance(): PublicNetworkService {
    if (!PublicNetworkService.instance) {
      PublicNetworkService.instance = new PublicNetworkService();
    }
    return PublicNetworkService.instance;
  }

  public start(): void {
    if (this.checkIntervalTimer) return;

    this.lastInterfaceFingerprint = this.getInterfaceFingerprint();
    void this.getPublicNetworkInfo();

    this.checkIntervalTimer = setInterval(() => {
      this.checkInterfaceChange();
    }, INTERFACE_CHECK_INTERVAL_MS);
  }

  public stop(): void {
    if (this.checkIntervalTimer) {
      clearInterval(this.checkIntervalTimer);
      this.checkIntervalTimer = undefined;
    }
    this.listeners = [];
  }

  public onUpdate(callback: (info: PublicNetworkInfo) => void): () => void {
    this.listeners.push(callback);
    if (this.cachedInfo) {
      callback(this.cachedInfo);
    }
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }

  public getCachedInfo(): PublicNetworkInfo | undefined {
    return this.cachedInfo;
  }

  private notify(info: PublicNetworkInfo): void {
    this.listeners.forEach(cb => {
      try {
        cb(info);
      } catch (err) {
        console.error('[PublicNetworkService] Listener notification error:', err);
      }
    });
  }

  private getInterfaceFingerprint(): string {
    try {
      const ifaces = networkInterfaces();
      const activeNonInternal = Object.entries(ifaces)
        .filter(([, addrs]) => addrs && addrs.some(a => !a.internal))
        .map(([name, addrs]) => {
          const ips = (addrs || [])
            .filter(a => !a.internal)
            .map(a => a.address)
            .sort()
            .join(';');
          return `${name}:${ips}`;
        })
        .sort()
        .join('|');
      return activeNonInternal;
    } catch {
      return '';
    }
  }

  private checkInterfaceChange(): void {
    const currentFingerprint = this.getInterfaceFingerprint();
    if (currentFingerprint && this.lastInterfaceFingerprint && currentFingerprint !== this.lastInterfaceFingerprint) {
      this.lastInterfaceFingerprint = currentFingerprint;
      void this.getPublicNetworkInfo(true);
    } else {
      this.lastInterfaceFingerprint = currentFingerprint;
    }
  }

  /**
   * Checks network interfaces for common VPN / tunnel virtual adapters.
   */
  public detectVpnInterfaces(): {isVpn: boolean; vpnName?: string} {
    try {
      const ifaces = networkInterfaces();
      for (const [name, addrs] of Object.entries(ifaces)) {
        if (!addrs || addrs.length === 0) continue;
        const hasActiveAddress = addrs.some(a => !a.internal && a.address && a.address !== '0.0.0.0');
        if (hasActiveAddress && VPN_INTERFACE_PATTERN.test(name)) {
          return {isVpn: true, vpnName: name};
        }
      }
    } catch {
      // Ignore OS query errors
    }

    return {isVpn: false};
  }

  private hasProxyConfigured(): boolean {
    return Boolean(
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.ALL_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy ||
      process.env.all_proxy,
    );
  }

  /**
   * Fetches public IP and Geo telemetry from external service with fallback.
   */
  public async getPublicNetworkInfo(forceRefresh = false): Promise<PublicNetworkInfo> {
    const now = Date.now();
    if (!forceRefresh && this.cachedInfo && now - this.lastFetchTime < CACHE_TTL_MS) {
      return this.cachedInfo;
    }

    if (this.isFetching && this.pendingFetchPromise) {
      return this.pendingFetchPromise;
    }

    this.isFetching = true;
    this.pendingFetchPromise = this.performFetch()
      .then(info => {
        this.cachedInfo = info;
        this.lastFetchTime = Date.now();
        this.notify(info);
        return info;
      })
      .catch(err => {
        console.warn('[PublicNetworkService] Failed to query public network info:', err);
        const fallback = this.buildFallbackInfo();
        this.cachedInfo = fallback;
        this.notify(fallback);
        return fallback;
      })
      .finally(() => {
        this.isFetching = false;
        this.pendingFetchPromise = undefined;
      });

    return this.pendingFetchPromise;
  }

  private buildFallbackInfo(): PublicNetworkInfo {
    const localVpn = this.detectVpnInterfaces();
    return {
      ip: this.cachedInfo?.ip || 'Offline',
      country: this.cachedInfo?.country || undefined,
      countryCode: this.cachedInfo?.countryCode || undefined,
      flagEmoji: this.cachedInfo?.flagEmoji || undefined,
      city: this.cachedInfo?.city || undefined,
      region: this.cachedInfo?.region || undefined,
      isp: this.cachedInfo?.isp || undefined,
      org: this.cachedInfo?.org || undefined,
      isVpn: localVpn.isVpn || Boolean(this.cachedInfo?.isVpn),
      vpnName: localVpn.vpnName || this.cachedInfo?.vpnName || undefined,
      isProxy: this.hasProxyConfigured() || Boolean(this.cachedInfo?.isProxy),
      lastUpdated: Date.now(),
    };
  }

  private async performFetch(): Promise<PublicNetworkInfo> {
    const localVpn = this.detectVpnInterfaces();
    const isProxy = this.hasProxyConfigured();

    // Primary: ipwho.is (Free, HTTPS, rich metadata with emoji flag, ISP, ASN, security)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const res = await fetch('https://ipwho.is/', {
        signal: controller.signal,
        headers: {Accept: 'application/json', 'User-Agent': 'LynxHub-HardwareMonitor/1.0'},
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data && data.success !== false && data.ip) {
          const isSecurityVpn = Boolean(data.security?.vpn || data.security?.tor || data.security?.proxy);
          const isVpn = localVpn.isVpn || isSecurityVpn;
          const vpnName = localVpn.vpnName || (isSecurityVpn ? data.connection?.isp || 'VPN Active' : undefined);

          return {
            ip: data.ip,
            country: data.country || undefined,
            countryCode: data.country_code || undefined,
            flagEmoji: data.flag?.emoji || undefined,
            city: data.city || undefined,
            region: data.region || undefined,
            isp: data.connection?.isp || undefined,
            org: data.connection?.org || undefined,
            isVpn,
            vpnName,
            isProxy: isProxy || Boolean(data.security?.proxy),
            lastUpdated: Date.now(),
          };
        }
      }
    } catch {
      // Proceed to secondary fallback
    }

    // Secondary fallback: Cloudflare CDN-CGI trace
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const res = await fetch('https://1.1.1.1/cdn-cgi/trace', {
        signal: controller.signal,
        headers: {'User-Agent': 'LynxHub-HardwareMonitor/1.0'},
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const text = await res.text();
        const ipMatch = text.match(/ip=([^\r\n]+)/);
        const locMatch = text.match(/loc=([^\r\n]+)/);
        const warpMatch = text.match(/warp=([^\r\n]+)/);

        if (ipMatch && ipMatch[1]) {
          const isWarp = Boolean(warpMatch && warpMatch[1] === 'on');
          const isVpn = Boolean(localVpn.isVpn || isWarp);
          const vpnName = localVpn.vpnName || (isWarp ? 'Cloudflare WARP' : undefined);

          return {
            ip: ipMatch[1].trim(),
            countryCode: locMatch ? locMatch[1].trim() : undefined,
            isVpn,
            vpnName,
            isProxy,
            lastUpdated: Date.now(),
          };
        }
      }
    } catch {
      // Proceed to tertiary fallback
    }

    // Tertiary fallback: ipify
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const res = await fetch('https://api64.ipify.org?format=json', {
      signal: controller.signal,
      headers: {'User-Agent': 'LynxHub-HardwareMonitor/1.0'},
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data && data.ip) {
        return {
          ip: data.ip,
          isVpn: localVpn.isVpn,
          vpnName: localVpn.vpnName,
          isProxy,
          lastUpdated: Date.now(),
        };
      }
    }

    throw new Error('All public IP queries failed');
  }
}

export const publicNetworkService = PublicNetworkService.getInstance();
