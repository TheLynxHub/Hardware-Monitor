import {BoltIcon, Radar2Icon, ServerPathIcon} from '@solar-icons/react/bold-duotone';
import {memo, useEffect, useMemo, useState} from 'react';

import {HMONITOR_IPC_STOP_PING, HMONITOR_IPC_UPDATE_PING} from '../../../../cross/constants';
import {HardwareFlyoutPayload, NetworkDiagnostic, PingData, PingHistorySample} from '../../../../cross/types';
import {useHMonitorState} from '../../../state/hmonitorSlice';
import HardwareFlyoutTrigger from '../../common/HardwareFlyoutTrigger';
import MetricItem from '../../common/MetricItem';
import Section from '../../common/Section';

type PingDisplayState = Record<string, PingData | null>;
type PingHistoryState = Record<string, PingHistorySample[]>;

const MAX_HISTORY_SAMPLES = 60;

function PingSection() {
  const pingState = useHMonitorState('pingState');

  const [hostResults, setHostResults] = useState<PingDisplayState>({});
  const [hostHistory, setHostHistory] = useState<PingHistoryState>({});

  const renderElements = useMemo(() => {
    const allHosts = new Set<string>();

    // If autoPingGateway is enabled, include detected gateway host first
    if (pingState.autoPingGateway !== false) {
      Object.keys(hostResults).forEach(h => {
        if (hostResults[h]?.isGateway) {
          allHosts.add(h);
        }
      });
    }

    // Add user enabled hosts
    (pingState.enabledHosts || []).forEach(h => {
      allHosts.add(h);
    });

    const hostList = Array.from(allHosts);

    // Compute Dual-Target LAN vs WAN diagnostic
    let lanItem: PingData | null = null;
    let wanItem: PingData | null = null;

    for (const h of hostList) {
      const item = hostResults[h];
      if (!item) continue;
      if (item.isGateway && !lanItem) {
        lanItem = item;
      } else if (!item.isGateway && !wanItem && item.latency !== undefined) {
        wanItem = item;
      }
    }

    let diagnostic: NetworkDiagnostic | undefined;
    if (lanItem && wanItem) {
      const lanLat = lanItem.latency ?? -1;
      const wanLat = wanItem.latency ?? -1;
      const lanLoss = lanItem.packetLoss ?? 0;
      const wanLoss = wanItem.packetLoss ?? 0;

      if (wanLat === -1 && lanLat !== -1) {
        diagnostic = {
          status: 'disconnected',
          title: 'Internet Disconnected',
          description:
            `Local gateway responds (${lanLat} ms), but WAN host (${wanItem.host}) is unreachable.` +
            ' Check your ISP connection or modem.',
          lanLatency: lanLat,
          wanLatency: undefined,
          lanLoss,
          wanLoss: 100,
        };
      } else if (lanLat > 40 || lanLoss >= 5) {
        diagnostic = {
          status: 'lan-bottleneck',
          title: 'Local LAN Congestion',
          description:
            `High local gateway ping (${lanLat} ms, ${lanLoss}% loss).` +
            ' The bottleneck is on your local Wi-Fi or Ethernet network.',
          lanLatency: lanLat,
          wanLatency: wanLat >= 0 ? wanLat : undefined,
          lanLoss,
          wanLoss,
        };
      } else if (wanLat > 120 || wanLoss >= 5) {
        diagnostic = {
          status: 'wan-lag',
          title: 'ISP / Internet Lag',
          description:
            `Local gateway is fast (${lanLat} ms, 0% loss), but WAN latency is elevated (${wanLat} ms).` +
            ' Lag is external to your local network.',
          lanLatency: lanLat,
          wanLatency: wanLat,
          lanLoss,
          wanLoss,
        };
      } else {
        diagnostic = {
          status: 'optimal',
          title: 'Connection Optimal',
          description:
            `Both local gateway (${lanLat} ms) and external Internet (${wanLat} ms)` +
            ' have low latency and zero packet loss.',
          lanLatency: lanLat,
          wanLatency: wanLat,
          lanLoss,
          wanLoss,
        };
      }
    }

    return hostList.map(host => {
      const item = hostResults[host];
      const isGw = Boolean(item?.isGateway || host.toLowerCase().includes('gateway'));
      const label = item?.label || (isGw ? `LAN (${host})` : host);

      let value: string;
      let colorClass: string | undefined;

      if (!item || item.latency == null) {
        value = '-1';
        colorClass = 'text-warning';
      } else {
        value = `${item.latency} ms`;
        if (item.packetLoss && item.packetLoss > 0) {
          value += ` (${item.packetLoss}% loss)`;
          colorClass = item.packetLoss >= 20 ? 'text-danger' : 'text-warning';
        }
      }

      const history = hostHistory[host] || [];

      const flyoutPayload: HardwareFlyoutPayload = {
        section: 'ping',
        ping: {
          host,
          data: item,
          history,
          diagnostic,
        },
      };

      const HostIcon = isGw ? ServerPathIcon : BoltIcon;

      return (
        <HardwareFlyoutTrigger key={host} section="ping" payload={flyoutPayload}>
          <MetricItem label={label} value={value} icon={HostIcon} colorClass={colorClass} />
        </HardwareFlyoutTrigger>
      );
    });
  }, [hostResults, hostHistory, pingState]);

  useEffect(() => {
    const clearListener = window.electron.ipcRenderer.on(HMONITOR_IPC_UPDATE_PING, (_, result) => {
      const now = Date.now();
      if (typeof result === 'string') {
        const host = result;
        setHostResults(prevResults => ({
          ...prevResults,
          [host]: {
            host,
            timeString: new Date().toLocaleTimeString(),
            latency: undefined,
            packetLoss: 100,
          },
        }));
        setHostHistory(prev => {
          const current = prev[host] || [];
          return {...prev, [host]: [...current, {timestamp: now, latency: null}].slice(-MAX_HISTORY_SAMPLES)};
        });
      } else {
        const data = result as PingData;
        setHostResults(prevResults => ({...prevResults, [data.host]: data}));
        setHostHistory(prev => {
          const current = prev[data.host] || [];
          return {
            ...prev,
            [data.host]: [
              ...current,
              {
                timestamp: now,
                latency: data.latency ?? null,
                jitter: data.jitter,
                packetLoss: data.packetLoss,
              },
            ].slice(-MAX_HISTORY_SAMPLES),
          };
        });
      }
    });

    const clearStopListener = window.electron.ipcRenderer.on(HMONITOR_IPC_STOP_PING, (_, host) => {
      setHostResults(prevState => {
        const {[host]: _, ...remainingHosts} = prevState;
        return remainingHosts;
      });
      setHostHistory(prevHistory => {
        const {[host]: _, ...remainingHistory} = prevHistory;
        return remainingHistory;
      });
    });

    return () => {
      clearListener();
      clearStopListener();
    };
  }, []);

  return (
    <Section title="Ping" icon={Radar2Icon}>
      {renderElements}
    </Section>
  );
}

export default memo(PingSection);
