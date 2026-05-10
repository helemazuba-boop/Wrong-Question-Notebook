'use client';

import { useTranslations } from 'next-intl';

interface Esp32DeviceCardProps {
  device: {
    id: string;
    mac_address: string;
    device_name: string;
    firmware_version?: string | null;
    last_seen_at?: string | null;
    created_at: string;
  };
  onUnpair: (deviceId: string) => void;
  unpairing: boolean;
}

export function Esp32DeviceCard({
  device,
  onUnpair,
  unpairing,
}: Esp32DeviceCardProps) {
  const t = useTranslations('ESP32');

  const formatLastSeen = (dateStr: string | null | undefined) => {
    if (!dateStr) return t('never');
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return t('justNow');
    if (diffMins < 60) return t('minutesAgo', { n: diffMins });
    if (diffHours < 24) return t('hoursAgo', { n: diffHours });
    if (diffDays < 7) return t('daysAgo', { n: diffDays });
    return t('weeksAgo', { n: Math.floor(diffDays / 7) });
  };

  return (
    <div className="flex items-center justify-between rounded-lg border p-3 gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5 text-muted-foreground"
          >
            <rect width="18" height="12" x="3" y="6" rx="2" ry="2" />
            <path d="M3 12h18" />
            <circle cx="7" cy="12" r="1" fill="currentColor" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">
            {device.device_name || t('title')}
          </p>
          <p className="text-xs text-muted-foreground font-mono">
            {device.mac_address}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-muted-foreground">
              {t('lastSeen', { time: formatLastSeen(device.last_seen_at) })}
            </span>
            {device.firmware_version && (
              <span className="text-xs text-muted-foreground">
                v{device.firmware_version}
              </span>
            )}
          </div>
        </div>
      </div>
      <button
        onClick={() => onUnpair(device.id)}
        disabled={unpairing}
        className="shrink-0 text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 px-2 py-1"
      >
        {unpairing ? t('unpairing') : t('unpair')}
      </button>
    </div>
  );
}
