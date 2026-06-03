'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Esp32PairingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPairSuccess: () => void;
}

function isValidMac(mac: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac);
}

function formatMacInput(value: string): string {
  const hex = value
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '')
    .slice(0, 12);

  return hex.match(/.{1,2}/g)?.join(':') ?? '';
}

export function Esp32PairingDialog({
  open,
  onOpenChange,
  onPairSuccess,
}: Esp32PairingDialogProps) {
  const t = useTranslations('ESP32');
  const tCommon = useTranslations('Common');

  const [macInput, setMacInput] = useState('');
  const [macError, setMacError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedMac = macInput.trim().toUpperCase();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMacInput(formatMacInput(e.target.value));
    setMacError(null);
    setError(null);
  };

  const handlePair = async () => {
    if (!isValidMac(normalizedMac)) {
      setMacError(t('invalidMacFormat'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/esp32/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mac_address: normalizedMac }),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error || t('pairFailed'));
      } else {
        setSuccess(true);
        onPairSuccess();
        setTimeout(() => {
          onOpenChange(false);
          setMacInput('');
          setSuccess(false);
        }, 1500);
      }
    } catch {
      setError(t('pairFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    setMacInput('');
    setMacError(null);
    setError(null);
    setSuccess(false);
  };

  return (
    <Dialog open={open} onOpenChange={nextOpen => !nextOpen && handleClose()}>
      <DialogContent className="rounded-2xl border-amber-200/40 sm:max-w-md dark:border-amber-800/30">
        <DialogHeader>
          <DialogTitle>{t('pairNewDevice')}</DialogTitle>
          <DialogDescription>
            {success ? t('pairingSuccessHint') : t('pairingInstructions')}
          </DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6 text-green-600 dark:text-green-400"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p className="font-medium">{t('pairingSuccess')}</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('macAddress')}
                <span className="text-destructive ml-0.5">*</span>
              </label>
              <Input
                value={macInput}
                onChange={handleInputChange}
                placeholder="AA:BB:CC:DD:EE:FF"
                className={`font-mono uppercase ${macError ? 'border-destructive' : ''}`}
                autoComplete="off"
                spellCheck={false}
              />
              {macError && (
                <p className="text-xs text-destructive">{macError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('macFormatHint')}
              </p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">{t('howToFindMac')}</p>
              <p>{t('macExplanation')}</p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                {tCommon('cancel')}
              </Button>
              <Button onClick={handlePair} disabled={loading || !normalizedMac}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('startPairing')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
