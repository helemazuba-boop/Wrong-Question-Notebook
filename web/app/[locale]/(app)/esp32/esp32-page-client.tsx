'use client';

import { useCallback, useEffect, useState } from 'react';
import { Cpu, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Esp32DeviceCard } from '@/components/esp32/esp32-device-card';
import { Esp32PairingDialog } from '@/components/esp32/esp32-pairing-dialog';
import { PageHeader } from '@/components/page-header';

type Esp32Device = {
  id: string;
  mac_address: string;
  device_name: string;
  firmware_version?: string | null;
  last_seen_at?: string | null;
  created_at: string;
};

export default function Esp32PageClient() {
  const t = useTranslations('ESP32');
  const tCommon = useTranslations('Common');

  const [devices, setDevices] = useState<Esp32Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [pairingDialogOpen, setPairingDialogOpen] = useState(false);
  const [unpairingId, setUnpairingId] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const res = await fetch('/api/esp32/devices');
      const json = await res.json();
      if (json.success) {
        setDevices(json.data.devices || []);
      }
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const handleUnpair = async (deviceId: string) => {
    setUnpairingId(deviceId);
    try {
      const res = await fetch(`/api/esp32/devices?id=${deviceId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setDevices(prev => prev.filter(device => device.id !== deviceId));
      }
    } finally {
      setUnpairingId(null);
    }
  };

  return (
    <div className="section-container">
      <PageHeader
        title={t('title')}
        description={t('pageSubtitle')}
        actions={
          <>
            <Button
              variant="outline"
              onClick={loadDevices}
              disabled={devicesLoading}
              className="rounded-xl"
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${devicesLoading ? 'animate-spin' : ''}`}
              />
              {tCommon('refresh')}
            </Button>
            <Button
              onClick={() => setPairingDialogOpen(true)}
              className="btn-cta-primary py-2.5"
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('pairNewDevice')}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <section className="landing-card border-amber-200/40 from-amber-50 to-orange-100/50 dark:border-amber-800/30 dark:from-amber-950/40 dark:to-orange-900/20">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="landing-icon-box bg-amber-500/10 dark:bg-amber-500/20">
                <Cpu className="h-6 w-6 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <h2 className="landing-card-title">{t('devices')}</h2>
                <p className="landing-card-text">{t('devicesHint')}</p>
              </div>
            </div>
          </div>

          {devicesLoading ? (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200/40 bg-white/70 px-4 py-5 text-sm text-muted-foreground dark:border-amber-800/30 dark:bg-gray-900/40">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tCommon('loading')}
            </div>
          ) : devices.length === 0 ? (
            <div className="rounded-xl border border-dashed border-amber-300/60 bg-white/70 px-4 py-8 text-center dark:border-amber-800/40 dark:bg-gray-900/40">
              <p className="font-medium text-gray-900 dark:text-white">
                {t('noDevicesTitle')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('noDevicesDesc')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {devices.map(device => (
                <Esp32DeviceCard
                  key={device.id}
                  device={device}
                  unpairing={unpairingId === device.id}
                  onUnpair={handleUnpair}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="landing-card border-blue-200/40 from-blue-50 to-blue-100/50 dark:border-blue-800/30 dark:from-blue-950/40 dark:to-blue-900/20">
          <div className="landing-icon-box bg-blue-500/10 dark:bg-blue-500/20">
            <Cpu className="h-6 w-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="space-y-2">
            <h2 className="landing-card-title">{t('howToFindClaimCode')}</h2>
            <p className="landing-card-text">{t('claimCodeExplanation')}</p>
            <p className="font-mono text-sm text-blue-700 dark:text-blue-300">
              12345678
            </p>
          </div>
        </aside>
      </div>

      <Esp32PairingDialog
        open={pairingDialogOpen}
        onOpenChange={setPairingDialogOpen}
        onPairSuccess={loadDevices}
      />
    </div>
  );
}
