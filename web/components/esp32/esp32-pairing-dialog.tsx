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

function formatClaimCode(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, 8);
}

export function Esp32PairingDialog({
  open,
  onOpenChange,
  onPairSuccess,
}: Esp32PairingDialogProps) {
  const t = useTranslations('ESP32');
  const tCommon = useTranslations('Common');

  const [claimCode, setClaimCode] = useState('');
  const [claimError, setClaimError] = useState<string | null>(null);
  const [action, setAction] = useState<'add' | 'restore'>('add');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setClaimCode(formatClaimCode(e.target.value));
    setClaimError(null);
    setError(null);
  };

  const handlePair = async () => {
    if (!/^[0-9]{8}$/.test(claimCode)) {
      setClaimError(t('invalidClaimCode'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const requestId = `web_${crypto.randomUUID().replaceAll('-', '')}`;
      const res = await fetch('/api/esp32/v3/claim/approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WQN-Protocol': '3',
          'X-WQN-Request-Id': requestId,
        },
        body: JSON.stringify({
          request_id: requestId,
          display_code: claimCode,
          action,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error?.code || t('pairFailed'));
      } else {
        setSuccess(true);
        onPairSuccess();
        setTimeout(() => {
          onOpenChange(false);
          setClaimCode('');
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
    setClaimCode('');
    setClaimError(null);
    setAction('add');
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
                {t('claimCode')}
                <span className="text-destructive ml-0.5">*</span>
              </label>
              <Input
                value={claimCode}
                onChange={handleInputChange}
                placeholder="12345678"
                inputMode="numeric"
                className={`font-mono tracking-[0.25em] ${claimError ? 'border-destructive' : ''}`}
                autoComplete="one-time-code"
                spellCheck={false}
              />
              {claimError && (
                <p className="text-xs text-destructive">{claimError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('claimCodeHint')}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={action === 'add' ? 'default' : 'outline'}
                onClick={() => setAction('add')}
              >
                {t('addNewDevice')}
              </Button>
              <Button
                type="button"
                variant={action === 'restore' ? 'default' : 'outline'}
                onClick={() => setAction('restore')}
              >
                {t('restoreDevice')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {action === 'restore'
                ? t('restoreDeviceHint')
                : t('addNewDeviceHint')}
            </p>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">
                {t('howToFindClaimCode')}
              </p>
              <p>{t('claimCodeExplanation')}</p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                {tCommon('cancel')}
              </Button>
              <Button
                onClick={handlePair}
                disabled={loading || claimCode.length !== 8}
              >
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
