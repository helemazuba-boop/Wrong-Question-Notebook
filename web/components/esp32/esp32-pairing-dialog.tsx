'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

interface Esp32PairingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPairSuccess: () => void;
}

function isValidMac(mac: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac);
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

  if (!open) return null;

  const normalizedMac = macInput.trim().toUpperCase();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = e.target.value.toUpperCase();
    // Auto-insert colons
    value = value.replace(/[^0-9A-F]/g, '');
    if (value.length > 2) {
      value = value.slice(0, 2) + ':' + value.slice(2);
    }
    if (value.length > 5) {
      value = value.slice(0, 5) + ':' + value.slice(5);
    }
    if (value.length > 8) {
      value = value.slice(0, 8) + ':' + value.slice(8);
    }
    if (value.length > 11) {
      value = value.slice(0, 11) + ':' + value.slice(11);
    }
    if (value.length > 14) {
      value = value.slice(0, 14);
    }
    setMacInput(value);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-xl shadow-lg w-full max-w-md mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('pairNewDevice')}</h2>
          <button
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

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
            <p className="text-sm text-muted-foreground text-center">
              {t('pairingSuccessHint')}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t('pairingInstructions')}
            </p>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('macAddress')}
                <span className="text-destructive ml-0.5">*</span>
              </label>
              <Input
                value={macInput}
                onChange={handleInputChange}
                placeholder="AA:BB:CC:DD:EE:FF"
                maxLength={17}
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

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">{t('howToFindMac')}</p>
              <p>{t('macExplanation')}</p>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={handleClose}>
                {tCommon('cancel')}
              </Button>
              <Button
                onClick={handlePair}
                disabled={loading || !normalizedMac}
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('startPairing')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
