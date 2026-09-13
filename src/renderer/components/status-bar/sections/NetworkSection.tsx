import {convertStorageUnit, formatSize} from '@lynx_common/utils';
import {GlobalIcon, ShieldCheckIcon, ShieldCrossIcon} from '@solar-icons/react/bold-duotone';
import {Activity, ArrowDown, ArrowUp, Database, Gauge, Power, Thermometer, Wifi} from 'lucide-react';
import {ElementType, memo, ReactNode, useMemo, useState} from 'react';

import {
  HardwareFlyoutPayload,
  HardwareInfo,
  HardwareMetricsConfig,
  NetworkData,
  NetworkInterfaceDetails,
  PublicNetworkInfo,
  RawSensorValue,
} from '../../../../cross/types';
import {useHMonitorState} from '../../../state/hmonitorSlice';
import {getNetworkAlias} from '../../../utils/aliasUtils';
import HardwareFlyoutTrigger from '../../common/HardwareFlyoutTrigger';
import MetricItem from '../../common/MetricItem';
import Section from '../../common/Section';

const getIconForSensorType = (type: string): ElementType => {
  switch (type) {
    case 'Temperature':
      return Thermometer;
    case 'Load':
      return Activity;
    case 'Power':
      return Power;
    case 'Clock':
      return Gauge;
    case 'Data':
    case 'SmallData':
      return Database;
    default:
      return Activity;
  }
};

const maskIp = (ip: string): string => {
  if (!ip || ip === 'Resolving...' || ip === 'Offline') return ip;
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.•••.•••`;
  }
  return ip.length > 8 ? `${ip.slice(0, 8)}••••` : '••••••••';
};

type Props = {
  data: NetworkData | undefined;
  metrics: HardwareMetricsConfig;
  hardwareInfo: HardwareInfo | undefined;
  rawSensorValues: RawSensorValue[];
  networkDetails?: NetworkInterfaceDetails[];
  publicNetwork?: PublicNetworkInfo;
};

const NetworkSection = memo(({data, metrics, hardwareInfo, rawSensorValues, networkDetails, publicNetwork}: Props) => {
  const showAliasNetwork = useHMonitorState('showAliasNetwork');
  const maskPublicIp = useHMonitorState('maskPublicIp') ?? true;
  const [isTemporarilyUnmasked, setIsTemporarilyUnmasked] = useState(false);
  const isMasked = maskPublicIp && !isTemporarilyUnmasked;

  const {name, uploadSpeed, downloadSpeed, uploadData, downloadData} = data || {
    name: '',
    uploadSpeed: 0,
    downloadSpeed: 0,
    uploadData: 0,
    downloadData: 0,
  };

  const hasUploadSpeed = useMemo(() => metrics.enabled.includes('uploadSpeed'), [metrics.enabled]);
  const hasDownloadSpeed = useMemo(() => metrics.enabled.includes('downloadSpeed'), [metrics.enabled]);
  const hasUploadData = useMemo(() => metrics.enabled.includes('uploadData'), [metrics.enabled]);
  const hasDownloadData = useMemo(() => metrics.enabled.includes('downloadData'), [metrics.enabled]);
  const hasPublicIp = useMemo(() => metrics.enabled.includes('publicIp'), [metrics.enabled]);
  const hasVpnStatus = useMemo(() => metrics.enabled.includes('vpnStatus'), [metrics.enabled]);

  const sensorReadingMap = useMemo(() => {
    const map = new Map<string, RawSensorValue>();
    rawSensorValues.forEach(val => map.set(val.Identifier, val));
    return map;
  }, [rawSensorValues]);

  const title = showAliasNetwork ? getNetworkAlias(name) : name;

  const renderedMetrics = useMemo(() => {
    const list: ReactNode[] = [];
    const processedIds = new Set<string>();

    metrics.enabled.forEach(metricId => {
      processedIds.add(metricId);
      if (metricId === 'uploadSpeed') {
        list.push(<MetricItem label="Up" icon={ArrowUp} key="uploadSpeed" value={formatSize(uploadSpeed)} />);
      } else if (metricId === 'downloadSpeed') {
        list.push(<MetricItem label="Down" icon={ArrowDown} key="downloadSpeed" value={formatSize(downloadSpeed)} />);
      } else if (metricId === 'uploadData') {
        list.push(
          <MetricItem
            icon={ArrowUp}
            label="Up Data"
            key="uploadData"
            value={formatSize(convertStorageUnit(uploadData?.toString() ?? '0', 'GB', 'B') || 0)}
          />,
        );
      } else if (metricId === 'downloadData') {
        list.push(
          <MetricItem
            icon={ArrowDown}
            label="Down Data"
            key="downloadData"
            value={formatSize(convertStorageUnit(downloadData?.toString() ?? '0', 'GB', 'B') || 0)}
          />,
        );
      } else if (metricId === 'publicIp') {
        const rawIp = publicNetwork?.ip || 'Resolving...';
        const displayIp = isMasked ? maskIp(rawIp) : rawIp;
        const ipLabel = publicNetwork?.countryCode ? `${publicNetwork.countryCode} IP` : 'Public IP';

        list.push(
          <div
            onClick={e => {
              e.stopPropagation();
              setIsTemporarilyUnmasked(prev => !prev);
            }}
            title={
              (isMasked ? 'Click to reveal Public IP' : 'Click to mask Public IP') +
              (publicNetwork?.isp ? ` • ISP: ${publicNetwork.isp}` : '') +
              (publicNetwork?.city ? ` • ${publicNetwork.city}` : '') +
              (publicNetwork?.country ? ` • ${publicNetwork.country}` : '')
            }
            key="publicIp"
            className="cursor-pointer select-none inline-flex shrink-0">
            <MetricItem label={ipLabel} icon={GlobalIcon} value={displayIp} />
          </div>,
        );
      } else if (metricId === 'vpnStatus') {
        const isVpn = Boolean(publicNetwork?.isVpn);
        const vpnName = publicNetwork?.vpnName || (isVpn ? 'Active' : 'Direct');

        list.push(
          <MetricItem
            colorClass={
              isVpn
                ? 'text-success bg-success/10 border-success/30'
                : 'text-semi-muted bg-surface border-surface-secondary'
            }
            label="VPN"
            key="vpnStatus"
            value={vpnName}
            icon={isVpn ? ShieldCheckIcon : ShieldCrossIcon}
          />,
        );
      } else {
        const customMetric = metrics.custom?.find(m => m.id === metricId);
        if (customMetric) {
          const sensorInfo = hardwareInfo?.sensors.find(s => s.Identifier === customMetric.sensorIdentifier);
          const sensorReading = sensorReadingMap.get(customMetric.sensorIdentifier);
          if (sensorInfo && sensorReading?.Value !== null && sensorReading?.Value !== undefined) {
            const value = Number.isInteger(sensorReading.Value)
              ? sensorReading.Value
              : parseFloat(sensorReading.Value.toFixed(1));
            list.push(
              <MetricItem
                value={value}
                key={customMetric.id}
                unit={sensorInfo.Unit}
                label={customMetric.label}
                icon={getIconForSensorType(sensorInfo.Type)}
              />,
            );
          }
        }
      }
    });

    const hasAnyMetric =
      hasUploadSpeed || hasDownloadSpeed || hasUploadData || hasDownloadData || hasPublicIp || hasVpnStatus;

    if (!hasAnyMetric && (!metrics.custom || metrics.custom.length === 0)) return null;

    metrics.custom?.forEach(customMetric => {
      if (processedIds.has(customMetric.id)) return;
      const sensorInfo = hardwareInfo?.sensors.find(s => s.Identifier === customMetric.sensorIdentifier);
      const sensorReading = sensorReadingMap.get(customMetric.sensorIdentifier);
      if (sensorInfo && sensorReading?.Value !== null && sensorReading?.Value !== undefined) {
        const value = Number.isInteger(sensorReading.Value)
          ? sensorReading.Value
          : parseFloat(sensorReading.Value.toFixed(1));
        list.push(
          <MetricItem
            value={value}
            key={customMetric.id}
            unit={sensorInfo.Unit}
            label={customMetric.label}
            icon={getIconForSensorType(sensorInfo.Type)}
          />,
        );
      }
    });

    return list;
  }, [
    metrics.enabled,
    metrics.custom,
    uploadSpeed,
    downloadSpeed,
    uploadData,
    downloadData,
    publicNetwork,
    isMasked,
    hasUploadSpeed,
    hasDownloadSpeed,
    hasUploadData,
    hasDownloadData,
    hasPublicIp,
    hasVpnStatus,
    hardwareInfo,
    sensorReadingMap,
  ]);

  const flyoutPayload = useMemo<HardwareFlyoutPayload>(
    () => ({
      section: 'network',
      network: {
        data,
        networkDetails,
        publicNetwork,
        rawSensorValues,
        metrics,
      },
    }),
    [data, networkDetails, publicNetwork, rawSensorValues, metrics],
  );

  if (renderedMetrics?.length === 0) return null;

  return (
    <HardwareFlyoutTrigger section="network" payload={flyoutPayload}>
      <Section icon={Wifi} title={title}>
        {renderedMetrics}
      </Section>
    </HardwareFlyoutTrigger>
  );
});

export default NetworkSection;
